const path = require('path');
const os = require('os');

const PROFILES_PATH = path.join(os.homedir(), '.git_profiles.json');
const TOKENS_PATH = path.join(os.homedir(), '.github_tokens.json');
const PROJECTS_PATH = path.join(os.homedir(), '.git_projects.json');

module.exports = {
    PROFILES_PATH,
    TOKENS_PATH,
    PROJECTS_PATH
};
