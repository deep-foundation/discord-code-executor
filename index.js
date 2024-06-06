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
    const regex = /```js\n([\s\S]*?)\n```/g;
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

    // Initialize variable for full-message.md attachment
    let fullMessageAttachment;
    
    // First check the attachments of the original message
    console.log('Attachments in original message:', message.attachments.map(att => att.name));
    fullMessageAttachment = message.attachments.find(att => att.name.trim() === 'full-message.md');

    // If not found, check the attachments of the replied message (if any)
    if (!fullMessageAttachment) {
      const repliedMessage = await message.fetchReference().catch(() => null);
      if (repliedMessage) {
        console.log('Attachments in replied message:', repliedMessage.attachments.map(att => att.name));
        fullMessageAttachment = repliedMessage.attachments.find(att => att.name.trim() === 'full-message.md');
      }
    }

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
    const executeCode = (sourceCode, index) => {
      return new Promise((resolve) => {
        const filePath = path.join(messageDir, `code_${index}.js`);
        console.log({sourceCode});
        fsExtra.writeFileSync(filePath, sourceCode);

        const child = exec(`node ${filePath}`, { timeout: executionTimeout });

        let output = '';

        // Collect stdout and stderr streams
        child.stdout.on('data', (data) => output += data.toString());
        child.stderr.on('data', (data) => output += data.toString());

        child.on('close', (code) => {
          if (code === 0) {
            resolve({ code: sourceCode, output, status: 'success' });
          } else {
            resolve({ code: sourceCode, output, status: 'error' });
          }
        });

        // Set a timeout to kill the process if it exceeds the allowed execution time
        const timeout = setTimeout(() => {
          child.kill();
          resolve({ code: sourceCode, output, status: 'timeout', duration: executionTimeout / 1000 });
        }, executionTimeout);

        // Clear timeout on process end
        child.on('exit', () => {
          clearTimeout(timeout);
        });
      });
    };

    console.log({ allCodeBlocks });

    // Execute all code blocks in parallel
    const results = await Promise.all(allCodeBlocks.map((code, index) => executeCode(code, index)));

    let index = 0;
    // Send results as replies
    for (const result of results) {
      let content;
      if (result.status === 'success' || result.status === 'error') {
        content = `\`\`\`js\n${result.code}\n\`\`\`\nOutput:\n\`\`\`\n${result.output}\n\`\`\`\nStatus: ${result.status}`;
      } else {
        content = `\`\`\`js\n${result.code}\n\`\`\`\nExecution timed out after ${result.duration} seconds. Status: ${result.status}`;
      }
      
      if (content.length > maxMessageLength) {
        // Write the full content to a file and attach
        const codeFilePath = path.join(messageDir, `code_${index}.js`);
        const outputFilePath = path.join(messageDir, `output_${index}.txt`);
        
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
      index++;
    }

    // Clean up by removing the temporary directory for this message
    fsExtra.removeSync(messageDir);

  } catch (error) {
    // Send error message without stacktrace
    await message.reply(`Error: ${error.message}`);
    console.log(error);
  }
});

client.login(token);