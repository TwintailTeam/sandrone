async function github(path, options = {}) {
    const res = await fetch(`https://api.github.com${path}`, { ...options, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sandrone', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 409) { return { res, body: [] }; }
    if (!res.ok) { throw new Error(`GitHub ${path.split('?')[0]} returned HTTP ${res.status}`); }
    return { res, body: await res.json() };
}

async function sponsoredCents(id) {
    if (!process.env.GITHUB_SPONSORS_ACCOUNT || !process.env.GITHUB_TOKEN) { return 0; }
    for (let after = null; ;) {
        const { body } = await github('/graphql', { method: 'POST', body: JSON.stringify({ query: 'query($login: String!, $after: String) { repositoryOwner(login: $login) { ... on Sponsorable { lifetimeReceivedSponsorshipValues(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { amountInCents sponsor { ... on User { databaseId } ... on Organization { databaseId } } } } } } }', variables: { login: process.env.GITHUB_SPONSORS_ACCOUNT, after } }) });
        if (body.errors?.length) { throw new Error(`GitHub Sponsors: ${body.errors[0].message}`); }
        const values = body.data.repositoryOwner?.lifetimeReceivedSponsorshipValues;
        const match = values?.nodes.find((node) => String(node.sponsor?.databaseId) === String(id));
        if (match) { return match.amountInCents; }
        if (!values?.pageInfo.hasNextPage) { return 0; }
        after = values.pageInfo.endCursor;
    }
}

module.exports = {
    name: 'github',
    connection: 'github',
    async fetch(account) {
        const repos = (process.env.GITHUB_REPOS ?? '').split(',').map((repo) => repo.trim()).filter(Boolean);
        const { body: user } = await github(`/user/${account.id}`);
        let commits = 0;
        let mergedPrs = 0;
        for (const repo of repos) {
            const { res, body } = await github(`/repos/${repo}/commits?author=${encodeURIComponent(user.login)}&per_page=1`);
            const last = res.headers.get('link')?.match(/[?&]page=(\d+)>; rel="last"/)?.[1];
            commits += last ? Number(last) : body.length;
            await new Promise((resolve) => setTimeout(resolve, 2_500));
            mergedPrs += (await github(`/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged author:${user.login}`)}&per_page=1`)).body.total_count;
        }
        return { username: user.login, commits, mergedPrs, sponsoredCents: await sponsoredCents(account.id) };
    },
};
