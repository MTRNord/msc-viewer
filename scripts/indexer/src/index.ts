import { MeiliSearch } from 'meilisearch'
import { Octokit } from '@octokit/core';
import { throttling } from '@octokit/plugin-throttling'
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { MultiBar, Presets } from 'cli-progress';

//const INDEX = "MSCs";
const INDEX = "MSC_development";

const OWNER = "matrix-org";
const REPO = "matrix-spec-proposals";

function wait(ms: number) {
    return new Promise(function (resolve, reject) {
        setTimeout(resolve, ms);
    });
}

const multibar = new MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    format: ' {name} {bar} | {percentage} - {value}/{total} - {eta_formatted}',
}, Presets.shades_classic);
const prsBar = multibar.create(1, 0, { name: "PRs" });
const commentsBar = multibar.create(1, 0, { name: "Comments" });
const indexingBar = multibar.create(1, 0, { name: "Indexing" });

interface Comment {
    url: string;
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
    author_url: string;
    body: string;
    closedAt: number;
    createdAt: number;
    mergedAt: number;
    updatedAt: number;
    permalink: string;
    title: string;
    state: string;
    threads?: Threads;
    comments?: Comment[];
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

const MyOctokit = Octokit.plugin(throttling, paginateRest);

const octokit = new MyOctokit({
    auth: process.env.GIT_SECRET,
    throttle: {
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
            console.warn(
                `Request quota exhausted for request ${options.method} ${options.url}`,
            );

            if (retryCount <= 5) {
                // retry 5 times
                console.info(`Retrying after ${retryAfter} seconds!`);
                return true;
            }
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
            // does not retry, only logs a warning
            console.warn(
                `SecondaryRateLimit detected for request ${options.method} ${options.url}`,
            );
        },

    },
});

await client.deleteIndex(INDEX)
await client.updateIndex(INDEX, { primaryKey: 'uid' });

await client.index(INDEX).updateDisplayedAttributes([
    'uid',
    'author',
    'author_url',
    'body',
    "closedAt",
    "createdAt",
    "mergedAt",
    "updatedAt",
    "permalink",
    "title",
    "state",
    "threads",
    "comments",
    "labels",
]);
await client.index(INDEX).updateSearchableAttributes([
    "title",
    'author',
    'body',
    "state",
    "threads",
    "comments",
]);

const synonyms = {
    'ara4n': ['Matthew'],
    'turt2live': ["Travis", "TravisR"]
};
await client.index(INDEX).updateSynonyms(synonyms)

await client.index(INDEX).updateFilterableAttributes([
    'author',
    'state',
    'closedAt',
    'createdAt',
    'mergedAt',
    'updatedAt',
    "labels",
])
await client.index(INDEX).updateSortableAttributes(['closedAt', 'createdAt', 'mergedAt', 'updatedAt'])

async function wait_for_rate_limit() {
    // Wait for github to reset the rate limit by fetching the rate limit endpoint and waiting until the reset time
    const rate_limit = await octokit.request('GET /rate_limit');
    const reset_time = rate_limit.data.resources.core.reset;
    const current_time = Math.floor(Date.now() / 1000);
    const wait_time = reset_time - current_time;
    multibar.log(`Waiting for ${wait_time} seconds until the rate limit is reset.`)
    await wait(wait_time * 1000);
}

async function get_documents(): Promise<Document[]> {
    let prs = 0;
    let documents: Document[] = [];
    const prIterator = octokit.paginate.iterator(
        "GET /repos/{owner}/{repo}/pulls",
        {
            owner: OWNER,
            repo: REPO,
            per_page: 100,
            state: "all",
        }
    );

    let last_added = 0;
    for await (const response of prIterator) {
        const nodes = response.data;
        prs += nodes.length;
        prsBar.increment(last_added);
        prsBar.setTotal(prs);

        const new_documents = await Promise.allSettled(nodes.map(async (node: any): Promise<Document> => {
            const author = node.user ? node.user.login : "unknown author";
            const author_url = node.user ? node.user.url : undefined;
            const closedAt = dateToTimestamp(new Date(node.closed_at));
            const createdAt = dateToTimestamp(new Date(node.created_at));
            const mergedAt = dateToTimestamp(new Date(node.merged_at));
            const updatedAt = dateToTimestamp(new Date(node.updated_at));

            const labels = await get_labels(node.labels);
            return {
                uid: node.number,
                author: author,
                author_url: author_url,
                body: node.body,
                closedAt: closedAt,
                createdAt: createdAt,
                mergedAt: mergedAt,
                permalink: node.url,
                title: node.title,
                state: node.state,
                updatedAt: updatedAt,
                labels: labels
            }
        }));
        documents = documents.concat(new_documents.filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<Document>).value));
        last_added = new_documents.length;
    }

    prsBar.increment(last_added);
    commentsBar.setTotal(documents.length);
    indexingBar.setTotal(documents.length);

    for (let i = 0; i < documents.length; i++) {
        const document = documents[i];
        const { threads, comments } = await get_comments(document.uid);
        document.threads = threads;
        document.comments = comments;
        commentsBar.increment();
    }
    return documents;
}

function dateToTimestamp(date: Date): number {
    return date.getTime() / 1000;
}

async function get_labels(labels: { id: number, node_id: string, url: string, name: string, description: string, color: string, default: boolean }[]): Promise<{ name: string; color: string; }[]> {
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
        await wait(150);
    }
    return {
        threads: threads,
        comments: comments_aggregated
    }
}

/**
 * We want to wait until the status of the task is either `succeeded` or until
 * the `error` field has an error. If we got an error we print it and exit.
 * 
 * @param taskID The id of a meilisearch task
 */
async function waitForTaskToFailOrComplete(taskID: number, pr_number: number): Promise<number | undefined> {
    const task = await client.getTask(taskID);
    if (task.status === 'failed') {
        console.error(`Task failed for PR ${pr_number}:`, JSON.stringify(task, null, 2));
        //process.exit(1);
        return pr_number;
    } else if (task.status === 'succeeded') {
        return;
    } else {
        await wait(1000);
        await waitForTaskToFailOrComplete(taskID, pr_number);
    }
}

/**
 * We add documents one by one.
 * 
 * @param documents The documents to add to the index
 * @param primaryKey The primary key of the documents
 */
async function addDocuments(documents: Document[], primaryKey: string): Promise<number[]> {
    let errors: number[] = [];
    for (const document of documents) {
        const task = await client.index(INDEX).addDocuments([document], { primaryKey });
        //const error_pr = await waitForTaskToFailOrComplete(task.taskUid, document.number);
        indexingBar.increment();
        //if (error_pr) {
        //    errors.push(error_pr);
        //}
    }
    return errors;
}

async function main() {
    await wait_for_rate_limit();
    const documents = await get_documents();

    const errors = await addDocuments(documents, 'uid');

    multibar.stop();
    if (errors.length > 0) {
        console.error(`Failed to index the following PRs: ${errors.join(", ")}`);
    }
    const stats = await client.getStats();
    console.log(`Stats:`, JSON.stringify(stats, null, 2));
}

await main();
