import { MeiliSearch } from 'meilisearch'
import { Octokit } from '@octokit/core';
import { throttling } from '@octokit/plugin-throttling'
import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { paginateGraphql } from "@octokit/plugin-paginate-graphql";
import { paginateRest } from "@octokit/plugin-paginate-rest";

//const INDEX = "MSCs";
const INDEX = "MSC_development";

const OWNER = "matrix-org";
const REPO = "matrix-spec-proposals";
function wait(ms: number) {
    return new Promise(function (resolve, reject) {
        setTimeout(resolve, ms);
    });
}

interface Comment {
    url: string;
    pull_request_review_id?: number;
    id: number;
    diff_hunk: string;
    path: string;
    position?: number;
    commit_id: string;
    in_reply_to_id?: number;
    user?: {
        name?: string;
        login?: string;
        avatar_url?: string;
        url: string;
    };
    body: string;
    created_at: string;
    updated_at: string;
    pull_request_url: string;
    author_association: string;
    _links: {
        self: {
            href: string;
        };
        html: {
            href: string;
        };
        pull_request: {
            href: string;
        };
    };
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
    line?: number;
    side?: string;
    subject_type?: "line" | "file";
    reactions?: {
        url: string;
        total_count: number;
        "+1": number;
        "-1": number;
        laugh: number;
        confused: number;
        heart: number;
        hooray: number;
        eyes: number;
        rocket: number;
    };
};

interface Threads {
    [key: string]: Comment[];
};

interface Document {
    uid: number;
    author: string;
    body: string;
    closed: boolean;
    closedAt: number;
    createdAt: number;
    merged: boolean;
    mergedAt: number;
    number: number;
    permalink: string;
    title: string;
    state: string;
    updatedAt: number;
    threads: Threads;
    comments: Comment[];
    labels: { name: string; color: string; }[];
}


const client = new MeiliSearch({
    host: process.env.MEILI_HOST ?? 'http://127.0.0.1:7700',
    apiKey: process.env.APIKey,
    requestConfig: {
        headers: {
            Authorization: `Bearer ${process.env.APIKey}` ?? ''
        },
    }
})

const MyOctokit = Octokit.plugin(throttling, paginateGraphql, paginateRest);

const octokit = new MyOctokit({
    auth: process.env.GIT_SECRET,
    throttle: {
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
            octokit.log.warn(
                `Request quota exhausted for request ${options.method} ${options.url}`,
            );

            if (retryCount < 25) {
                // only retries once
                octokit.log.info(`Retrying after ${retryAfter} seconds!`);
                return true;
            }
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
            // does not retry, only logs a warning
            octokit.log.warn(
                `SecondaryRateLimit detected for request ${options.method} ${options.url}`,
            );
        },
    },
});

const prIterator = await octokit.graphql.paginate.iterator<GraphQlQueryResponseData>(
    `query paginate($cursor: String) {
        repository(owner: "matrix-org", name: "matrix-spec-proposals") {
            pullRequests(first: 100, after: $cursor) {
                nodes {
                    author {
                        login
                    }
                    body
                    closed
                    closedAt
                    createdAt
                    merged
                    mergedAt
                    number
                    permalink
                    title
                    state
                    updatedAt
                }
                pageInfo {
                    hasNextPage
                    endCursor
                }
            }
        }
    }`, {
    cursor: process.env.PREV_CURSOR ?? undefined
});

let prs = 0;
let lastCursor = "unknown";
// client.deleteIndex(INDEX)
await client.index(INDEX).updateDisplayedAttributes([
    'author',
    'body',
    'closed',
    "closedAt",
    "createdAt",
    "merged",
    "mergedAt",
    "number",
    "permalink",
    "title",
    "state",
    "updatedAt"
]);
await client.index(INDEX).updateSearchableAttributes([
    "title",
    'author',
    'body',
    "number",
    "state"
]);

const synonyms = {
    'ara4n': ['Matthew'],
    'turt2live': ["Travis", "TravisR"]
};
await client.index(INDEX).updateSynonyms(synonyms)

await client.index(INDEX).updateFilterableAttributes([
    'author',
    'state',
    'merged',
    'closed',
    'closedAt',
    'createdAt',
    'mergedAt',
    'updatedAt',
    "labels"])
await client.index(INDEX).updateSortableAttributes(['closedAt', 'createdAt', 'mergedAt', 'updatedAt'])

for await (const response of prIterator) {
    const resp: GraphQlQueryResponseData = response;
    const nodes = resp.repository.pullRequests.nodes;
    prs += nodes.length;
    console.log(`${prs} prs found.`);
    await client.index(INDEX).addDocuments(await Promise.all(nodes.map(async (node: any): Promise<Document> => {
        const author = node.author ? node.author.login : "unknown author";
        const closedAt = dateToTimestamp(new Date(node.closedAt));
        const createdAt = dateToTimestamp(new Date(node.createdAt));
        const mergedAt = dateToTimestamp(new Date(node.mergedAt));
        const updatedAt = dateToTimestamp(new Date(node.updatedAt));

        const { threads, comments } = await get_comments(node.number);
        const labels = await get_labels(node.number);
        return {
            uid: node.number,
            author: author,
            body: node.body,
            closed: node.closed,
            closedAt: closedAt,
            createdAt: createdAt,
            merged: node.merged,
            mergedAt: mergedAt,
            number: node.number,
            permalink: node.permalink,
            title: node.title,
            state: node.state,
            updatedAt: updatedAt,
            threads: threads,
            comments: comments,
            labels: labels
        }
    })));


    lastCursor = resp.repository.pullRequests.pageInfo.endCursor;
    // Dont overload meilisearch
    await wait(5000);
}
console.log(`Last Cursor: ${lastCursor}`);
console.log(`Stats: ${JSON.stringify(await client.getStats()), null, 2}`);

function dateToTimestamp(date: Date): number {
    return date.getTime() / 1000;
}

async function get_labels(pr_id: number): Promise<{ name: string; color: string; }[]> {
    const labels = await octokit.paginate(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
        {
            owner: OWNER,
            repo: REPO,
            issue_number: pr_id,
            per_page: 100,
        }
    );
    return labels.map((label: any) => {
        return {
            name: label.name,
            color: label.color
        }
    });
}

async function get_comments(pr_id: number): Promise<{ threads: Threads, comments: Comment[] }> {
    let threads: Threads = {};
    let comments_aggregated: Comment[] = [];
    const commentIterator = octokit.paginate.iterator(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        {
            owner: OWNER,
            repo: REPO,
            pull_number: pr_id,
            per_page: 100,
        }
    );
    for await (const response of commentIterator) {
        const data = response.data;
        for (const comment of data) {
            const clean_comment: Comment = {
                url: comment.url,
                pull_request_review_id: comment.pull_request_review_id ?? undefined,
                id: comment.id,
                diff_hunk: comment.diff_hunk,
                path: comment.path,
                position: comment.position,
                commit_id: comment.commit_id,
                in_reply_to_id: comment.in_reply_to_id,
                user: comment.user ? {
                    name: comment.user.name ?? undefined,
                    login: comment.user.login,
                    avatar_url: comment.user.avatar_url,
                    url: comment.user.url,
                } : undefined,
                body: comment.body,
                created_at: comment.created_at,
                updated_at: comment.updated_at,
                pull_request_url: comment.pull_request_url,
                author_association: comment.author_association,
                _links: {
                    self: {
                        href: comment._links.self.href,
                    },
                    html: {
                        href: comment._links.html.href,
                    },
                    pull_request: {
                        href: comment._links.pull_request.href,
                    },
                },
                start_line: comment.start_line ?? undefined,
                start_side: comment.start_side ?? undefined,
                line: comment.line,
                side: comment.side,
                subject_type: comment.subject_type,
                reactions: comment.reactions ? {
                    url: comment.reactions.url,
                    total_count: comment.reactions.total_count,
                    "+1": comment.reactions["+1"],
                    "-1": comment.reactions["-1"],
                    laugh: comment.reactions.laugh,
                    confused: comment.reactions.confused,
                    heart: comment.reactions.heart,
                    hooray: comment.reactions.hooray,
                    eyes: comment.reactions.eyes,
                    rocket: comment.reactions.rocket,
                } : undefined,
            };
            if (comment.pull_request_review_id) {
                if (threads[comment.pull_request_review_id] == undefined) {
                    threads[comment.pull_request_review_id] = [];
                }
                threads[comment.pull_request_review_id].push(clean_comment)
            } else {
                comments_aggregated.push(clean_comment)
            }
        }
    }
    console.log(`${Object.keys(threads).length} Threads and ${comments_aggregated.length} free standing comments in PR with number ${pr_id}`)
    return {
        threads: threads,
        comments: comments_aggregated
    }
}
