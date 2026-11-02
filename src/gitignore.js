const inquirer = require('inquirer');
const chalk = require('chalk');
const { getDetectedCategories, writeGitignore } = require('./core/gitignore');
const { writeStatusOK, writeStatusWarn, writeStatusInfo } = require('./ui');

async function promptGitignore(targetPath) {
    const categories = getDetectedCategories(targetPath);
    const choices = [];
    let detectedCount = 0;

    for (const cat of categories) {
        choices.push(new inquirer.Separator(chalk.bold.cyan(`── ${cat.name} ──`)));
        for (const item of cat.items) {
            if (item.detected) detectedCount++;
            choices.push({
                name: `${item.pattern.padEnd(20)}${item.detected ? chalk.green(' [Detected]') : ''}`,
                value: item.pattern,
                checked: item.checked
            });
        }
    }

    if (detectedCount > 0) {
        writeStatusInfo(`Detected ${detectedCount} artifact(s) present in project.`);
    }

    console.log();
    const { selected } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'selected',
        message: 'Select patterns for .gitignore:',
        choices,
        pageSize: 18
    }]);

    const patterns = [...selected];

    while (true) {
        console.log();
        const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: `Selected ${patterns.length} pattern(s). Choose action:`,
            choices: [
                { name: '1. Save and write .gitignore', value: 'save' },
                { name: '2. Add custom pattern entry', value: 'custom' },
                { name: '3. Cancel / Skip', value: 'cancel' }
            ]
        }]);

        if (action === 'save') {
            writeGitignore(targetPath, patterns);
            writeStatusOK(`Created .gitignore with ${patterns.length} pattern(s).`);
            return true;
        }

        if (action === 'custom') {
            const { customPattern } = await inquirer.prompt([{
                type: 'input',
                name: 'customPattern',
                message: 'Enter custom pattern (e.g. *.tmp, secrets/):',
                validate: v => (v && v.trim().length > 0 ? true : 'Pattern cannot be empty')
            }]);

            const clean = customPattern.trim();
            if (!patterns.includes(clean)) {
                patterns.push(clean);
                writeStatusOK(`Added '${clean}' to pattern list.`);
            } else {
                writeStatusWarn(`'${clean}' is already selected.`);
            }
            continue;
        }

        if (action === 'cancel') {
            writeStatusWarn('.gitignore creation skipped.');
            return false;
        }
    }
}

module.exports = { promptGitignore };
