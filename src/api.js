const https = require('https');

function request(options, data = null) {
    if (data) {
        const bodyStr = JSON.stringify(data);
        options.headers = options.headers || {};
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        data = bodyStr;
    }

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch {}
                resolve({ status: res.statusCode, headers: res.headers, data: parsed, rawBody: body });
            });
        });

        req.on('error', reject);
        req.setTimeout(12000, () => {
            req.destroy(new Error('GitHub API request timed out (12s)'));
        });

        if (data) req.write(data);
        req.end();
    });
}

async function fetchUserRepositories(profile, token) {
    try {
        const res = await request({
            hostname: 'api.github.com',
            port: 443,
            path: `/user/repos?per_page=100&sort=updated`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'GitHub-Manager-CLI',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        if (res.status === 200 && Array.isArray(res.data)) {
            return res.data.map(r => ({
                name: r.name,
                full_name: r.full_name,
                private: !!r.private,
                description: r.description || '',
                html_url: r.html_url,
                owner: r.owner ? r.owner.login : profile.github_user
            }));
        }
        return null;
    } catch {
        return null;
    }
}

async function createRemoteRepo(token, repoName, isPrivate = true, description = '') {
    return await request({
        hostname: 'api.github.com',
        port: 443,
        path: '/user/repos',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'GitHub-Manager-CLI',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    }, {
        name: repoName,
        private: isPrivate,
        description: description || `Project: ${repoName}`
    });
}

async function deleteRemoteRepo(token, owner, repoName) {
    return await request({
        hostname: 'api.github.com',
        port: 443,
        path: `/repos/${owner}/${repoName}`,
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'GitHub-Manager-CLI',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
}

module.exports = {
    fetchUserRepositories,
    createRemoteRepo,
    deleteRemoteRepo
};
