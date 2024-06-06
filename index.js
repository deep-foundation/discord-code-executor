const { Client, Intents, MessageAttachment } = require('discord.js');
const fsExtra = require('fs-extra');
const { exec } = require('child_process');
const path = require('path');
const fetch = require('node-fetch'); // To fetch file content from the Discord CDN

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
  const maxMessageLength = 2000; // Discord max message length

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

    // Check for 'full-message.md' attachment
    const fullMessageAttachment = message.attachments.find(att => att.name === 'full-message.md');
    let allCodeBlocks = [];

    if (fullMessageAttachment) {
      // Fetch content from 'full-message.md'
      const response = await fetch(fullMessageAttachment.url);
      const fullMessageContent = await response.text();

      // Extract code blocks from the file content
      allCodeBlocks = extractCodeBlocks(fullMessageContent);
    } else {
      // Extract code blocks from the message and its reply (if any)
      const messageCodeBlocks = extractCodeBlocks(message.content);
      const repliedMessage = await message.fetchReference().catch(() => null);
      const replyCodeBlocks = repliedMessage ? extractCodeBlocks(repliedMessage.content) : [];

      allCodeBlocks = [...messageCodeBlocks, ...replyCodeBlocks];
    }

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
          let output;
          if (error) {
            output = error.killed
              ? `Execution timed out after ${executionTimeout / 1000} seconds.`
              : `Error: ${stderr}`;
            resolve({ code, output, status: 'error' });
          } else {
            output = stdout;
            resolve({ code, output, status: 'success' });
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

    // Send results as replies
    for (const result of results) {
      const content = `\`\`\`js\n${result.code}\n\`\`\`\nOutput:\n\`\`\`\n${result.output}\n\`\`\`\nStatus: ${result.status}`;
      
      if (content.length > maxMessageLength) {
        // Write the full content to a file and attach
        const codeFilePath = path.join(messageDir, `code_${result.status}.js`);
        const outputFilePath = path.join(messageDir, `output_${result.status}.txt`);
        
        fsExtra.writeFileSync(codeFilePath, result.code);
        fsExtra.writeFileSync(outputFilePath, result.output);

        const attachments = [
          new MessageAttachment(codeFilePath),
          new MessageAttachment(outputFilePath),
        ];

        await message.reply({
          content: `Execution status: ${result.status}`,
          files: attachments
        });
      } else {
        await message.reply({ content });
      }
    }

    // Clean up by removing the temporary directory for this message
    fsExtra.removeSync(messageDir);

  } catch (error) {
    // Send error message without stacktrace
    await message.reply(`Error: ${error.message}`);
  }
});

client.login(token);