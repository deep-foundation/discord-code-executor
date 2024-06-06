const { Client, Intents } = require('discord.js');
const fsExtra = require('fs-extra');
const { exec } = require('child_process');
const path = require('path');

// Load bot token from a file
const fs = require('fs');
const token = fs.readFileSync('token', 'utf8').trim();

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES] });

// Use system's temporary directory
const baseTempDir = path.join(require('os').tmpdir(), 'discord-code-executor');

// Ensure base temporary directory exists
fsExtra.ensureDirSync(baseTempDir);

client.on('messageCreate', async message => {
  if (!message.mentions.has(client.user)) return;

  const executionTimeout = 10000; // Timeout duration in milliseconds

  // Function to extract JS code blocks
  const extractCodeBlocks = text => {
    const regex = /```js\n([\s\S]*?)```/g;
    let match;
    const codeBlocks = [];
    while ((match = regex.exec(text)) !== null) {
      codeBlocks.push(match[1]);
    }
    return codeBlocks;
  };

  try {
    // Start typing indicator
    await message.channel.sendTyping();

    // Extract code blocks from the message and its reply (if any)
    const messageCodeBlocks = extractCodeBlocks(message.content);
    const repliedMessage = await message.fetchReference().catch(() => null);
    const replyCodeBlocks = repliedMessage ? extractCodeBlocks(repliedMessage.content) : [];

    const allCodeBlocks = [...messageCodeBlocks, ...replyCodeBlocks];

    if (allCodeBlocks.length === 0) {
      message.reply('No JS code blocks found.');
      return;
    }

    // Create a directory for this message's code execution
    const messageDir = path.join(baseTempDir, message.id.toString());
    fsExtra.ensureDirSync(messageDir);

    // Function to execute and capture JS code
    const executeCode = (code, index) => {
      return new Promise((resolve) => {
        const filePath = path.join(messageDir, `code_${index}.js`);
        fsExtra.writeFileSync(filePath, code);

        const child = exec(`node ${filePath}`, { timeout: executionTimeout }, (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              resolve({ code, output: `Execution timed out after ${executionTimeout / 1000} seconds.`, status: 'timeout' });
            } else {
              resolve({ code, output: `Error: ${stderr}`, status: 'error' });
            }
          } else {
            resolve({ code, output: stdout, status: 'success' });
          }
        });

        // Set a timeout to kill the process if it exceeds the allowed execution time
        setTimeout(() => {
          child.kill();
        }, executionTimeout);
      });
    };

    // Execute all code blocks in parallel
    const results = await Promise.all(allCodeBlocks.map((code, index) => executeCode(code, index)));

    // Send execution status as replies
    for (const result of results) {
      await message.reply({
        content: `Execution status: ${result.status}`
      });
    }

    // Clean up by removing the temporary directory for this message
    fsExtra.removeSync(messageDir);

  } catch (error) {
    // Send error message without stacktrace
    await message.reply(`Error: ${error.message}`);
  }
});

client.login(token);