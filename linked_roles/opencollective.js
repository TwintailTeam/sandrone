const OAUTH = 'https://opencollective.com/oauth';

async function graphql(query, variables, headers = {}, url = 'https://api.opencollective.com/graphql/v2') {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Sandrone', ...(process.env.OPENCOLLECTIVE_TOKEN ? { 'Personal-Token': process.env.OPENCOLLECTIVE_TOKEN } : {}), ...headers }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.errors?.length) { throw new Error(`Open Collective returned HTTP ${res.status}${body?.errors?.length ? `: ${body.errors[0].message}` : ''}`); }
    return body.data;
}

module.exports = {
    name: 'opencollective',
    enabled: () => Boolean(process.env.OPENCOLLECTIVE_CLIENT_ID && process.env.OPENCOLLECTIVE_CLIENT_SECRET && process.env.OPENCOLLECTIVE_COLLECTIVE),
    authorizeUrl: ({ redirectUri, state, challenge }) => `${OAUTH}/authorize?${new URLSearchParams({ client_id: process.env.OPENCOLLECTIVE_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' })}`,
    async identify({ code, redirectUri, verifier }) {
        const res = await fetch(`${OAUTH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Sandrone' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: process.env.OPENCOLLECTIVE_CLIENT_ID, client_secret: process.env.OPENCOLLECTIVE_CLIENT_SECRET, code, redirect_uri: redirectUri, code_verifier: verifier }), signal: AbortSignal.timeout(15_000) });
        if (!res.ok) { throw new Error(`Open Collective token exchange returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); }
        const { me } = await graphql('{ me { id slug } }', {}, { Authorization: `Bearer ${(await res.json()).access_token}` }, 'https://opencollective.com/api/graphql/v2');
        if (!me?.id) { throw new Error('Open Collective did not return the signed-in account'); }
        return { id: me.id, username: me.slug };
    },
    async fetch(account) {
        if (!process.env.OPENCOLLECTIVE_COLLECTIVE) { return 0; }
        let cents = 0;
        for (let offset = 0; ; offset += 100) {
            const { transactions } = await graphql('query($collective: String!, $from: String!, $offset: Int!) { transactions(account: [{ slug: $collective }], fromAccount: { id: $from }, kind: [CONTRIBUTION], type: CREDIT, isRefund: false, limit: 100, offset: $offset) { totalCount nodes { isRefunded amount { valueInCents } } } }', { collective: process.env.OPENCOLLECTIVE_COLLECTIVE, from: account.id, offset });
            cents += transactions.nodes.filter((node) => !node.isRefunded).reduce((sum, node) => sum + node.amount.valueInCents, 0);
            if (offset + 100 >= transactions.totalCount) { return cents; }
        }
    },
};
