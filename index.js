});

  blocks.push({ type: 'divider' });

  // Footer with poll info
  const voteTypeText = isMultiple ? 'Multiple choice' : 'Single choice';
  const anonymousText = isAnonymous ? 'Anonymous' : 'Public';
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${voteTypeText} • ${anonymousText} • 0 total votes • Click to vote`
    }]
  });

  return {
    blocks,
    pollId,
    pollData: {
      ...data,
      id: pollId,
      options,
      isAnonymous,
      isMultiple
    }
  };
}

// ================================
// MESSAGE SENDING
// ================================

async function sendMessage(msg) {
  try {
    console.log(`Attempting to send ${msg.type} message to channel: ${msg.channel}`);

    if (!msg.channel) {
      console.error('No channel specified in message data');
      return false;
    }

    try {
      const channelInfo = await app.client.conversations.info({ channel: msg.channel });
      console.log(`Channel accessible: #${channelInfo.channel.name}`);
    } catch (channelError) {
      console.error(`Channel access failed for ${msg.channel}:`, channelError?.data || channelError?.message);
      return false;
    }

    if (msg.type === 'capacity') {
      const messageText = (msg.title ? `*${msg.title}*\n` : '') + (msg.text || templates.capacity) + cat();
      const result = await app.client.chat.postMessage({
        channel: msg.channel,
        text: messageText
      });
    
      if (result.ok && result.ts) {
        try {
          await app.client.reactions.add({
            channel: msg.channel,
            timestamp: result.ts,
            name: 'black_cat'
          });
        } catch (e) {
          console.error('Reaction failed for :black_cat::', e?.data?.error || e?.message);
        }
      }
    } else if (msg.type === 'poll') {
      console.log('Sending poll message...');
      const pollMessage = await createPollMessage(msg);
      
      const result = await app.client.chat.postMessage({
        channel: msg.channel,
        text: msg.title || 'Poll',
        blocks: pollMessage.blocks
      });

      if (result.ok && result.ts) {
        activePollMessages.set(result.ts, pollMessage.pollData);
        console.log(`Poll created successfully: ${pollMessage.pollId}`);
      }
      
      return result.ok;
    } else if (msg.type === 'help') {
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: (msg.title ? `*${msg.title}*\n` : '') + (msg.text || templates.help) + cat()
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'danger',
              text: { type: 'plain_text', text: 'Request Backup' },
              action_id: `help_click_${msg.id}`,
              value: JSON.stringify({
                msgId: msg.id,
                alertChannels: msg.alertChannels || []
              })
            }
          ]
        }
      ];

      await app.client.chat.postMessage({
        channel: msg.channel,
        text: msg.text || 'Help button',
        blocks
      });

    } else {
      const messageText = (msg.title ? `*${msg.title}*\n` : '') + (msg.text || '(no content)') + cat();
      await app.client.chat.postMessage({
        channel: msg.channel,
        text: messageText
      });
    }

    console.log(`${msg.type} message sent successfully to channel ${msg.channel}`);
    return true;
  } catch (e) {
    console.error('Send failed with error:', e);
    return false;
  }
}

// ================================
// SCHEDULING
// ================================

function scheduleJob(msg) {
  if (jobs.has(msg.id)) {
    try { jobs.get(msg.id).destroy(); } catch (_) {}
    jobs.delete(msg.id);
  }

  const [hh, mm] = msg.time.split(':').map(Number);
  let cronExpr;

  if (msg.repeat === 'daily') {
    cronExpr = `${mm} ${hh} * * 1-5`;
  } else if (msg.repeat === 'weekly') {
    const day = new Date(msg.date).getDay();
    if (day >= 1 && day <= 5) {
      cronExpr = `${mm} ${hh} * * ${day}`;
    } else {
      console.log(`Weekly schedule skipped (weekend): ${msg.id}`);
      return;
    }
  } else if (msg.repeat === 'monthly') {
    const day = msg.date.split('-')[2];
    cronExpr = `${mm} ${hh} ${day} * 1-5`;
  } else {
    const [y, mon, d] = msg.date.split('-');
    cronExpr = `${mm} ${hh} ${d} ${mon} *`;
  }

  const job = cron.schedule(cronExpr, async () => {
    console.log(`Executing scheduled ${msg.type} message`);
    const success = await sendMessage(msg);

    if (msg.repeat === 'none') {
      scheduledMessages = scheduledMessages.filter(m => m.id !== msg.id);
      saveMessages();
      try { job.destroy(); } catch (_) {}
      jobs.delete(msg.id);
    }
  }, { timezone: 'America/New_York' });

  jobs.set(msg.id, job);
}

// ================================
// SLASH COMMANDS
// ================================

app.command('/cat', async ({ ack, body, client, context }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: createModal('menu')
    });
  } catch (error) {
    console.error('Failed to open modal:', error);
  }
});

app.command('/capacity', async ({ ack, body, client, context }) => {
  await ack();
  await openDirectModal(body, client, context, 'capacity');
});

app.command('/help', async ({ ack, body, client, context }) => {
  await ack();
  await openDirectModal(body, client, context, 'help');
});

app.command('/poll', async ({ ack, body, client, context }) => {
  await ack();
  await openDirectModal(body, client, context, 'poll');
});

app.command('/manage', async ({ ack, body, client, context }) => {
  await ack();
  await openScheduledMessagesView(body, client, context);
});

async function openDirectModal(body, client, context, messageType) {
  try {
    const userId = body.user_id;
    let data = {};
    
    // Initialize data based on message type
    switch (messageType) {
      case 'capacity':
        data = { 
          type: 'capacity', 
          text: templates.capacity, 
          userModifiedText: false, 
          scheduleType: 'schedule' 
        };
        break;
        
      case 'help':
        data = { 
          type: 'help', 
          text: templates.help, 
          userModifiedText: false, 
          alertChannels: [], 
          scheduleType: 'schedule' 
        };
        break;
        
      case 'poll':
        data = { 
          type: 'poll', 
          title: '', 
          question: '', 
          pollOptions: 'Option 1\nOption 2', 
          pollSettings: [], 
          scheduleType: 'schedule' 
        };
        break;
        
      default:
        data = { 
          type: 'custom', 
          text: '', 
          title: '', 
          scheduleType: 'schedule' 
        };
    }
    
    formData.set(userId, data);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: createModal(messageType, data)
    });

  } catch (error) {
    console.error(`Failed to open ${messageType} modal:`, error);
    
    try {
      await client.chat.postEphemeral({
        channel: body.channel_id,
        user: body.user_id,
        text: `Sorry, there was an issue opening the ${messageType} form. Try using \`/cat\` instead.`
      });
    } catch (e) {
      console.error('Failed to send fallback message:', e);
    }
  }
}

async function openScheduledMessagesView(body, client, context) {
  try {
    const userId = body.user_id;
    
    const userScheduledMessages = scheduledMessages.filter(msg => 
      msg.user_id === userId || msg.created_user_id === userId
    );

    await client.views.open({
      trigger_id: body.trigger_id,
      view: createManageModal(userScheduledMessages, userId)
    });

  } catch (error) {
    console.error('Failed to open manage modal:', error);
    
    try {
      const userScheduledMessages = scheduledMessages.filter(msg => 
        msg.user_id === body.user_id || msg.created_user_id === body.user_id
      );
      
      let message = `You have ${userScheduledMessages.length} scheduled message${userScheduledMessages.length === 1 ? '' : 's'}.\n\n`;
      
      if (userScheduledMessages.length === 0) {
        message += 'Use `/cat` to create your first scheduled message!';
      } else {
        message += 'Your scheduled messages:\n';
        userScheduledMessages.slice(0, 5).forEach(msg => {
          const nextRun = msg.repeat === 'none' ? 
            `${msg.date} at ${formatTimeDisplay(msg.time)}` : 
            `${msg.repeat} at ${formatTimeDisplay(msg.time)}`;
          message += `• ${msg.type}: ${nextRun} → <#${msg.channel}>\n`;
        });
        
        if (userScheduledMessages.length > 5) {
          message += `\n...and ${userScheduledMessages.length - 5} more.`;
        }
      }

      await client.chat.postEphemeral({
        channel: body.channel_id,
        user: body.user_id,
        text: message
      });
    } catch (e) {
      console.error('Failed to send fallback message:', e);
    }
  }
}

function createManageModal(userScheduledMessages, userId) {
  const blocks = [
    { 
      type: 'header', 
      text: { 
        type: 'plain_text', 
        text: `Your Scheduled Messages (${userScheduledMessages.length} total)` 
      }
    },
    { type: 'divider' }
  ];

  if (userScheduledMessages.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*No scheduled messages yet!*\n\nCreate your first scheduled message:\n• Use \`/cat\` for the full menu\n• Use \`/poll\` for a quick poll\n• Use \`/capacity\` for a capacity check\n• Use \`/help\` for a help button${cat()}`
      }
    });
    
    blocks.push({
      type: 'actions',
      elements: [
        { 
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Create Message' }, 
          action_id: 'manage_create_message'
        }
      ]
    });
  } else {
    const sortedMessages = userScheduledMessages.sort((a, b) => {
      if (a.repeat !== 'none' && b.repeat === 'none') return -1;
      if (a.repeat === 'none' && b.repeat !== 'none') return 1;
      
      const aTime = new Date(`${a.date} ${a.time}`);
      const bTime = new Date(`${b.date} ${b.time}`);
      return aTime - bTime;
    });

    sortedMessages.forEach((msg, index) => {
      const nextRun = msg.repeat === 'none' ? 
        `${msg.date} at ${formatTimeDisplay(msg.time)}` : 
        `${msg.repeat} at ${formatTimeDisplay(msg.time)}`;
      
      const typeIcon = getTypeIcon(msg.type);
      const statusText = isDateTimeInPast(msg.date, msg.time) && msg.repeat === 'none' ? 
        ' ⚠️ (Past due)' : '';
      
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${typeIcon} *${msg.title || msg.type}*${statusText}\n${nextRun} → <#${msg.channel}>\n\n_${(msg.text || msg.question || '').substring(0, 100)}${(msg.text || msg.question || '').length > 100 ? '...' : ''}_`
        },
        accessory: {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Delete' },
          action_id: `manage_delete_${msg.id}`,
          value: msg.id,
          confirm: {
            title: { type: 'plain_text', text: 'Delete Scheduled Message' },
            text: { type: 'mrkdwn', text: `Are you sure you want to delete "*${msg.title || msg.type}*"?\n\nThis action cannot be undone.` },
            confirm: { type: 'plain_text', text: 'Delete' },
            deny: { type: 'plain_text', text: 'Cancel' }
          }
        }
      });
      
      if (index < sortedMessages.length - 1) {
        blocks.push({ type: 'divider' });
      }
    });

    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Quick Stats:*\n• Total: ${userScheduledMessages.length} messages\n• Recurring: ${userScheduledMessages.filter(m => m.repeat !== 'none').length}\n• One-time: ${userScheduledMessages.filter(m => m.repeat === 'none').length}`
        }
      },
      {
        type: 'actions',
        elements: [
          { 
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Create New Message' }, 
            action_id: 'manage_create_message'
          },
          { 
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: 'Delete All Past Due' }, 
            action_id: 'manage_delete_past_due',
            confirm: {
              title: { type: 'plain_text', text: 'Delete Past Due Messages' },
              text: { type: 'mrkdwn', text: 'This will delete all one-time messages that are past their scheduled time. Recurring messages will not be affected.\n\nThis action cannot be undone.' },
              confirm: { type: 'plain_text', text: 'Delete Past Due' },
              deny: { type: 'plain_text', text: 'Cancel' }
            }
          }
        ]
      }
    );
  }

  return {
    type: 'modal',
    callback_id: 'manage_modal',
    title: { type: 'plain_text', text: 'Manage Scheduled Messages' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: blocks
  };
}

// ================================
// POLL VOTING HANDLER
// ================================

app.action(/^poll_vote_.+/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    const actionParts = action.action_id.split('_');
    const pollId = actionParts.slice(2, -1).join('_');
    const optionIndex = parseInt(actionParts[actionParts.length - 1]);
    const userId = body.user.id;
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    if (isNaN(optionIndex) || !pollVotes[pollId]) {
      console.log('Invalid poll vote - poll not found or invalid option');
      return;
    }

    // Get poll data from message
    let pollData = activePollMessages.get(messageTs);
    if (!pollData) {
      console.log('Poll data not found in memory');
      return;
    }

    // Handle voting logic
    const votes = pollVotes[pollId];
    const isMultiple = pollData.isMultiple;

    if (!isMultiple) {
      // Single choice - remove user from all options first
      Object.keys(votes).forEach(key => {
        votes[key].delete(userId);
      });
    }

    // Toggle vote for this option
    if (votes[optionIndex].has(userId)) {
      votes[optionIndex].delete(userId);
    } else {
      votes[optionIndex].add(userId);
    }

    // Update message with new vote counts
    await updatePollMessage(client, channel, messageTs, pollData, votes);

    // Send confirmation to user
    try {
      await client.chat.postEphemeral({
        channel: channel,
        user: userId,
        text: `Vote ${votes[optionIndex].has(userId) ? 'added' : 'removed'}!`
      });
    } catch (e) {
      console.log('Could not send ephemeral confirmation');
    }

  } catch (error) {
    console.error('Poll vote error:', error);
  }
});

async function updatePollMessage(client, channel, messageTs, pollData, votes) {
  try {
    const options = pollData.options;
    const isAnonymous = pollData.isAnonymous;
    const isMultiple = pollData.isMultiple;

    let blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${pollData.title || 'Poll'}*${cat()}`
        }
      }
    ];

    if (pollData.question) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: pollData.question
        }
      });
    }

    blocks.push({ type: 'divider' });

    // Update each option with current vote counts
    options.forEach((option, index) => {
      const voteCount = votes[index]?.size || 0;
      
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${option}*`
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: `Vote (${voteCount})`
          },
          action_id: `poll_vote_${pollData.id}_${index}`,
          value: `${index}`
        }
      });

      // Show voters or just count
      let voterText = voteCount === 0 ? 'No votes' : `${voteCount} vote${voteCount === 1 ? '' : 's'}`;
      if (!isAnonymous && voteCount > 0) {
        const voters = Array.from(votes[index]).map(userId => `<@${userId}>`).join(', ');
        voterText = voters;
      }

      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: voterText
        }]
      });
    });

    blocks.push({ type: 'divider' });

    // Update footer
    const totalVotes = Object.values(votes).reduce((sum, voteSet) => sum + voteSet.size, 0);
    const voteTypeText = isMultiple ? 'Multiple choice' : 'Single choice';
    const anonymousText = isAnonymous ? 'Anonymous' : 'Public';
    
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${voteTypeText} • ${anonymousText} • ${totalVotes} total votes • Click to vote`
      }]
    });

    await client.chat.update({
      channel: channel,
      ts: messageTs,
      text: pollData.title || 'Poll',
      blocks: blocks
    });

  } catch (error) {
    console.error('Failed to update poll message:', error);
  }
}

// ================================
// NAVIGATION HANDLERS
// ================================

['nav_menu', 'nav_scheduled', 'nav_preview', 'nav_schedule'].forEach(action => {
  app.action(action, async ({ ack, body, client }) => {
    await ack();
    try {
      const page = action.replace('nav_', '');
      const userId = body.user.id;
      let data = {};

      if (page !== 'menu' && page !== 'scheduled') {
        data = formData.get(userId) || {};

        if ((page === 'preview' || page === 'schedule') && body.view?.state?.values) {
          const values = body.view.state.values;

          // Extract common fields
          data = {
            ...data,
            ...(data.type !== 'capacity' && data.type !== 'help' && {
              title: getFormValue(values, 'title_block', 'title_input') || data.title
            }),
            text: getFormValue(values, 'text_block', 'text_input') || data.text,
          };

          // Handle poll-specific fields
          if (data.type === 'poll') {
            data.question = getFormValue(values, 'question_block', 'question_input') || data.question;
            
            const settingsBlock = values?.poll_settings_section?.poll_settings;
            data.pollSettings = settingsBlock?.selected_options?.map(opt => opt.value) || data.pollSettings || [];

            // Extract poll options
            let extractedOptions = [];
            let index = 0;
            while (values[`option_${index}_block`]) {
              const optionValue = values[`option_${index}_block`][`option_${index}_input`]?.value?.trim();
              if (optionValue) extractedOptions.push(optionValue);
              index++;
            }
            if (extractedOptions.length > 0) {
              data.pollOptions = extractedOptions.join('\n');
            }
          }

          if (data.text && data.type) {
            data.userModifiedText = hasUserModifiedTemplate(data.type, data.text);
          }

          if (page === 'schedule' || page === 'preview') {
            data.channel = getFormValue(values, 'channel_block', 'channel_select', 'conversation') || data.channel;
            data.date = getFormValue(values, 'date_block', 'date_picker', 'date') || data.date;
            data.time = getFormValue(values, 'time_block', 'time_picker', 'time') || data.time;
            data.repeat = getFormValue(values, 'repeat_block', 'repeat_select', 'selected') || data.repeat || 'none';
          }

          if (data.type === 'help') {
            const extractedAlertChannels = getFormValue(values, 'alert_channels_block', 'alert_channels_select', 'conversations');
            data.alertChannels = extractedAlertChannels || data.alertChannels || [];
          }
        }

        if (!data.scheduleType) {
          data.scheduleType = 'schedule';
        }

        formData.set(userId, data);
      }

      await client.views.update({
        view_id: body.view.id,
        view: createModal(page, data)
      });
    } catch (error) {
      console.error(`Failed to navigate to ${action}:`, error);
    }
  });
});

// Form type navigation handlers
['nav_capacity', 'nav_help', 'nav_custom'].forEach(action => {
  app.action(action, async ({ ack, body, client }) => {
    await ack();
    try {
      const messageType = action.replace('nav_', '');
      const userId = body.user.id;
      let data = formData.get(userId) || {};

      if (!data.type || data.type !== messageType) {
        if (messageType === 'capacity') {
          data = { type: 'capacity', text: templates.capacity, userModifiedText: false, scheduleType: 'schedule' };
        } else if (messageType === 'help') {
          data = { type: 'help', text: templates.help, userModifiedText: false, alertChannels: [], scheduleType: 'schedule' };
        } else if (messageType === 'custom') {
          data = { type: 'custom', text: '', title: '', scheduleType: 'schedule' };
        }
      } else {
        data.type = messageType;
        if (!data.text && (messageType === 'capacity' || messageType === 'help')) {
          data.text = messageType === 'capacity' ? templates.capacity : templates.help;
          data.userModifiedText = false;
        }
        if (messageType === 'help' && !data.alertChannels) {
          data.alertChannels = [];
        }
      }

      if (!data.scheduleType) data.scheduleType = 'schedule';
      formData.set(userId, data);

      await client.views.update({
        view_id: body.view.id,
        view: createModal(messageType, data)
      });
    } catch (error) {
      console.error(`Failed to navigate to ${action}:`, error);
    }
  });
});

// Poll option management
app.action('add_poll_option', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};
    const values = body.view.state.values;

    let options = [];
    let index = 0;
    while (values[`option_${index}_block`]) {
      const optionValue = values[`option_${index}_block`][`option_${index}_input`]?.value?.trim();
      if (optionValue) options.push(optionValue);
      index++;
    }

    options.push(`Option ${options.length + 1}`);
    data.pollOptions = options.join('\n');
    formData.set(userId, data);

    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Add poll option error:', error);
  }
});

app.action('remove_poll_option', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};
    const values = body.view.state.values;

    let options = [];
    let index = 0;
    while (values[`option_${index}_block`]) {
      const optionValue = values[`option_${index}_block`][`option_${index}_input`]?.value?.trim();
      if (optionValue) options.push(optionValue);
      index++;
    }

    if (options.length > 2) {
      options.pop();
    }
    
    data.pollOptions = options.join('\n');
    formData.set(userId, data);

    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Remove poll option error:', error);
  }
});

// Template reset handlers
['reset_template_capacity', 'reset_template_help'].forEach(action => {
  app.action(action, async ({ ack, body, client }) => {
    await ack();
    try {
      const type = action.replace('reset_template_', '');
      const userId = body.user.id;
      let data = formData.get(userId) || {};

      if (type === 'capacity') {
        data.text = templates.capacity;
      } else if (type === 'help') {
        data.text = templates.help;
      }
      data.userModifiedText = false;
      formData.set(userId, data);

      await client.views.update({
        view_id: body.view.id,
        view: createModal(type, data)
      });
    } catch (error) {
      console.error(`Failed to reset template for ${action}:`, error);
    }
  });
});

// Schedule page handlers
app.action('timing_now', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};/**
 * PM Squad Bot - Cat Scratch (Complete Version with Polling)
 * Flow: Menu → Form (content) → Preview → Schedule (channel + timing) → Send/Schedule
 * Requirements: npm i @slack/bolt node-cron dotenv
 * ENV: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
 */

const { App } = require('@slack/bolt');
const cron = require('node-cron');
const fs = require('fs');
require('dotenv').config();

// ================================
// INITIALIZATION
// ================================

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  port: process.env.PORT || 3000
});

// ================================
// STORAGE & STATE
// ================================

const SCHEDULE_FILE = './scheduledMessages.json';
let scheduledMessages = [];
const jobs = new Map();
const pollVotes = {}; // Store poll votes in memory
const formData = new Map();
const activePollMessages = new Map();

function saveMessages() {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduledMessages, null, 2));
  } catch (e) {
    console.error('Save failed:', e);
  }
}

function loadMessages() {
  if (fs.existsSync(SCHEDULE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE));
      scheduledMessages = data.filter(msg => {
        if (msg.repeat !== 'none') return true;
        return !isDateTimeInPast(msg.date, msg.time);
      });
      saveMessages();
    } catch (e) {
      console.error('Load failed:', e);
      scheduledMessages = [];
    }
  }
}

// ================================
// UTILITIES
// ================================

const generateId = () => `msg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const cat = () => Math.random() < 0.2 ? ' ₍^. .^₎' : '';

function todayInEST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function currentTimeInEST() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function formatTimeDisplay(timeStr) {
  const [hour, minute] = timeStr.split(':').map(Number);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${displayHour}:${minute.toString().padStart(2, '0')} ${period}`;
}

function isDateTimeInPast(dateStr, timeStr) {
  try {
    const now = new Date();
    const currentEST = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);

    const currentTimeEST = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now);

    if (dateStr !== currentEST) {
      return dateStr < currentEST;
    }
    return timeStr < currentTimeEST;
  } catch (error) {
    console.error('Timezone calculation error:', error);
    return false;
  }
}

function getFormValue(values, blockId, actionId, type = 'value') {
  const block = values?.[blockId]?.[actionId];

  if (type === 'selected') return block?.selected_option?.value;
  if (type === 'conversation') {
    return block?.selected_conversation || block?.initial_conversation || block?.selected_channel || block?.value;
  }
  if (type === 'conversations') {
    return block?.selected_conversations || block?.initial_conversations || [];
  }
  if (type === 'time') return block?.selected_time;
  if (type === 'date') return block?.selected_date;

  return block?.value?.trim();
}

function getInitialTextValue(page, data) {
  if (data.text !== undefined) return data.text;
  if (page === 'capacity') return templates.capacity;
  if (page === 'help') return templates.help;
  return '';
}

function hasUserModifiedTemplate(type, text) {
  if (!text) return false;
  const template = type === 'capacity' ? templates.capacity : type === 'help' ? templates.help : '';
  return template && text !== template;
}

function getTeamOrEnterpriseId(context) {
  // Mock function - implement based on your existing logic
  return context?.teamId || 'default_team';
}

function getTypeIcon(type) {
  switch (type) {
    case 'poll': return '📊';
    case 'capacity': return '📈';
    case 'help': return '🆘';
    case 'custom': return '💬';
    default: return '📝';
  }
}

function getMostPopularMessageType(messages) {
  if (messages.length === 0) return 'None yet';
  
  const counts = messages.reduce((acc, msg) => {
    acc[msg.type] = (acc[msg.type] || 0) + 1;
    return acc;
  }, {});

  const mostPopular = Object.entries(counts).reduce((a, b) => 
    counts[a[0]] > counts[b[0]] ? a : b
  );

  return `${mostPopular[0]} (${mostPopular[1]})`;
}

// ================================
// TEMPLATES
// ================================

const templates = {
  capacity: "Daily Bandwidth Check\nHow's everyone's capacity looking today?\n\nUse the reactions below to share your current workload:\n🟢 Light schedule - Ready for new work\n🟡 Manageable schedule\n🟠 Schedule is full, no new work\n🔴 Overloaded - Need help now",
  help: "Need Backup?\nIf you're stuck or need assistance, click the button below to alert the team."
};

// ================================
// PREVIEW GENERATOR
// ================================

function generatePreview(data) {
  let previewText = '';

  if (data.type === 'poll') {
    previewText += `*${data.title || 'Poll'}*\n`;
    if (data.question) previewText += `${data.question}\n\n`;

    if (data.pollOptions) {
      const options = data.pollOptions.split('\n').filter(o => o.trim());
      previewText += options.map((opt, i) => `${i + 1}. ${opt.trim()}`).join('\n');

      if (data.pollSettings?.length > 0) {
        previewText += `\n\nSettings: ${data.pollSettings.join(', ')}`;
      }
    }
  } else if (data.title && data.type !== 'capacity' && data.type !== 'help') {
    previewText += `*${data.title}*\n`;
  }

  if (data.type === 'capacity') {
    previewText += data.text || templates.capacity;
  } else if (data.type === 'help') {
    previewText += data.text || templates.help;
    previewText += '\n\nRequest Backup (button)';
  } else if (data.type !== 'poll') {
    if (data.title) previewText += `*${data.title}*\n`;
    previewText += data.text || '(no content)';
  }

  previewText += cat();

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Preview:*\n\`\`\`${previewText.substring(0, 500)}${previewText.length > 500 ? '...' : ''}\`\`\``
    }
  };
}

// ================================
// MODAL CREATION
// ================================

function createModal(page, data = {}) {
  const base = {
    type: 'modal',
    callback_id: `scheduler_${page}`,
    title: { type: 'plain_text', text: 'PM Squad Manager' },
    close: { type: 'plain_text', text: 'Cancel' }
  };

  if (page === 'menu') {
    return {
      ...base,
      title: { type: 'plain_text', text: 'Cat Scratch Menu' },
      blocks: [
        { 
          type: 'header', 
          text: { 
            type: 'plain_text', 
            text: 'Choose Your Message Type' 
          }
        },
        { type: 'divider' },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Team Communication Tools*'
          }
        },
        {
          type: 'actions',
          elements: [
            { 
              type: 'button', 
              style: 'primary',
              text: { type: 'plain_text', text: 'Capacity Check' }, 
              action_id: 'nav_capacity' 
            }
          ]
        },
        {
          type: 'actions',
          elements: [
            { 
              type: 'button', 
              style: 'danger',
              text: { type: 'plain_text', text: 'Help Button' }, 
              action_id: 'nav_help' 
            },
            { 
              type: 'button', 
              text: { type: 'plain_text', text: 'Custom Message' }, 
              action_id: 'nav_custom' 
            }
          ]
        },
        { type: 'divider' },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Management*'
          }
        },
        {
          type: 'actions',
          elements: [
            { 
              type: 'button', 
              text: { type: 'plain_text', text: 'View Scheduled Messages' }, 
              action_id: 'nav_scheduled' 
            }
          ]
        }
      ]
    };
  }

  if (page === 'scheduled') {
    const blocks = [
      { 
        type: 'header', 
        text: { 
          type: 'plain_text', 
          text: `Scheduled Messages (${scheduledMessages.length} total)` 
        }
      },
      { type: 'divider' }
    ];

    if (scheduledMessages.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*No scheduled messages yet*\n\nCreate your first scheduled message using the menu above!${cat()}`
        }
      });
    } else {
      scheduledMessages.forEach(msg => {
        const nextRun = msg.repeat === 'none' ? `${msg.date} at ${formatTimeDisplay(msg.time)}` : `${msg.repeat} at ${formatTimeDisplay(msg.time)}`;
        
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${msg.title || msg.type}*\n${nextRun}\n<#${msg.channel}>\n\n_${(msg.text || msg.question || '').substring(0, 100)}${(msg.text || msg.question || '').length > 100 ? '...' : ''}_`
          },
          accessory: {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: 'Delete' },
            action_id: `delete_message_${msg.id}`,
            value: msg.id,
            confirm: {
              title: { type: 'plain_text', text: 'Delete Message' },
              text: { type: 'mrkdwn', text: `Are you sure you want to delete "*${msg.title || msg.type}*"?\n\nThis action cannot be undone.` },
              confirm: { type: 'plain_text', text: 'Delete' },
              deny: { type: 'plain_text', text: 'Cancel' }
            }
          }
        });
      });
    }

    blocks.push(
      { type: 'divider' },
      { 
        type: 'actions', 
        elements: [
          { 
            type: 'button', 
            text: { type: 'plain_text', text: 'Back to Menu' }, 
            action_id: 'nav_menu' 
          }
        ]
      }
    );

    return { ...base, blocks };
  }

  if (page === 'preview') {
    const previewBlock = generatePreview(data);

    return {
      ...base,
      title: { type: 'plain_text', text: `${data.type ? data.type.charAt(0).toUpperCase() + data.type.slice(1) : 'Message'} Preview` },
      blocks: [
        { 
          type: 'header', 
          text: { 
            type: 'plain_text', 
            text: 'Step 2: Preview Your Message' 
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Here's how your *${data.type || 'message'}* will look when posted:`
          }
        },
        previewBlock,
        { type: 'divider' },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Ready to continue?* You can go back to edit or proceed to scheduling.'
          }
        },
        {
          type: 'actions',
          elements: [
            { 
              type: 'button', 
              text: { type: 'plain_text', text: 'Edit Message' }, 
              action_id: `nav_${data.type || 'custom'}` 
            },
            { 
              type: 'button', 
              style: 'primary', 
              text: { type: 'plain_text', text: 'Continue to Send/Schedule' }, 
              action_id: 'nav_schedule' 
            }
          ]
        }
      ]
    };
  }

  if (page === 'schedule') {
    const scheduleBlocks = [
      { 
        type: 'header', 
        text: { 
          type: 'plain_text', 
          text: 'Step 3: Send or Schedule Message' 
        }
      },
      { type: 'divider' },
      { 
        type: 'section', 
        text: { 
          type: 'mrkdwn', 
          text: '*Where to send this message:*' 
        }
      },
      {
        type: 'input',
        block_id: 'channel_block',
        label: { type: 'plain_text', text: 'Target Channel' },
        element: {
          type: 'conversations_select',
          action_id: 'channel_select',
          ...(data.channel && { initial_conversation: data.channel }),
          placeholder: { type: 'plain_text', text: 'Select channel to post message' }
        }
      }
    ];

    if (data.type === 'help') {
      scheduleBlocks.push({
        type: 'input',
        block_id: 'alert_channels_block',
        label: { type: 'plain_text', text: 'Alert Channels' },
        element: {
          type: 'multi_conversations_select',
          action_id: 'alert_channels_select',
          ...(data.alertChannels && data.alertChannels.length > 0 && { initial_conversations: data.alertChannels }),
          placeholder: { type: 'plain_text', text: 'Channels to notify when help is requested' }
        },
        hint: { type: 'plain_text', text: 'Select channels that will be alerted when someone clicks the help button' }
      });
    }

    scheduleBlocks.push(
      { type: 'divider' },
      { 
        type: 'section', 
        text: { 
          type: 'mrkdwn', 
          text: '*When to send this message:*' 
        }
      },
      {
        type: 'actions',
        block_id: 'send_timing_block',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Post Now' },
            style: data.scheduleType === 'now' ? 'primary' : undefined,
            action_id: 'timing_now',
            value: 'now'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Schedule for Later' },
            style: data.scheduleType === 'schedule' || !data.scheduleType ? 'primary' : undefined,
            action_id: 'timing_schedule',
            value: 'schedule'
          }
        ]
      }
    );

    if (data.scheduleType === 'schedule' || !data.scheduleType) {
      scheduleBlocks.push(
        { type: 'divider' },
        { 
          type: 'section', 
          text: { 
            type: 'mrkdwn', 
            text: '*Schedule Details:*' 
          }
        },
        {
          type: 'input',
          block_id: 'date_block',
          label: { type: 'plain_text', text: 'Date' },
          element: {
            type: 'datepicker',
            action_id: 'date_picker',
            initial_date: data.date || todayInEST(),
            placeholder: { type: 'plain_text', text: 'Select date' }
          }
        },
        {
          type: 'input',
          block_id: 'time_block',
          label: { type: 'plain_text', text: 'Time (EST)' },
          element: {
            type: 'timepicker',
            action_id: 'time_picker',
            initial_time: data.time || '09:00',
            placeholder: { type: 'plain_text', text: 'Select time' }
          }
        },
        {
          type: 'input',
          block_id: 'repeat_block',
          label: { type: 'plain_text', text: 'Repeat Schedule' },
          element: {
            type: 'static_select',
            action_id: 'repeat_select',
            initial_option: data.repeat === 'daily' ?
              { text: { type: 'plain_text', text: 'Daily' }, value: 'daily' } :
              data.repeat === 'weekly' ?
              { text: { type: 'plain_text', text: 'Weekly' }, value: 'weekly' } :
              data.repeat === 'monthly' ?
              { text: { type: 'plain_text', text: 'Monthly' }, value: 'monthly' } :
              { text: { type: 'plain_text', text: 'None (One-time)' }, value: 'none' },
            options: [
              { text: { type: 'plain_text', text: 'None (One-time)' }, value: 'none' },
              { text: { type: 'plain_text', text: 'Daily' }, value: 'daily' },
              { text: { type: 'plain_text', text: 'Weekly' }, value: 'weekly' },
              { text: { type: 'plain_text', text: 'Monthly' }, value: 'monthly' }
            ]
          }
        }
      );
    }

    scheduleBlocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          { 
            type: 'button', 
            text: { type: 'plain_text', text: 'Back to Preview' }, 
            action_id: 'nav_preview' 
          }
        ]
      }
    );

    return {
      ...base,
      title: { type: 'plain_text', text: 'Send or Schedule Message' },
      submit: { type: 'plain_text', text: 'Post' },
      blocks: scheduleBlocks
    };
  }

  // Poll form
  if (page === 'poll') {
    const blocks = [
      { 
        type: 'header', 
        text: { 
          type: 'plain_text', 
          text: 'Step 1: Create Your Poll' 
        }
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'title_block',
        label: { type: 'plain_text', text: 'Poll Title' },
        element: {
          type: 'plain_text_input',
          action_id: 'title_input',
          initial_value: data.title || '',
          placeholder: { type: 'plain_text', text: 'Enter poll title...' }
        }
      },
      {
        type: 'input',
        block_id: 'question_block',
        label: { type: 'plain_text', text: 'Poll Question' },
        element: {
          type: 'plain_text_input',
          action_id: 'question_input',
          multiline: true,
          initial_value: data.question || '',
          placeholder: { type: 'plain_text', text: 'What would you like to ask?' }
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Poll Options*'
        }
      }
    ];

    // Add poll options (minimum 2, maximum 10)
    const options = data.pollOptions ? data.pollOptions.split('\n').filter(o => o.trim()) : ['Option 1', 'Option 2'];
    while (options.length < 2) options.push(`Option ${options.length + 1}`);

    options.forEach((option, index) => {
      blocks.push({
        type: 'input',
        block_id: `option_${index}_block`,
        label: { type: 'plain_text', text: `Option ${index + 1}` },
        element: {
          type: 'plain_text_input',
          action_id: `option_${index}_input`,
          initial_value: option || '',
          placeholder: { type: 'plain_text', text: `Enter option ${index + 1}...` }
        },
        optional: index >= 2
      });
    });

    // Poll option management buttons
    const actionElements = [];
    if (options.length < 10) {
      actionElements.push({
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: 'Add Option' },
        action_id: 'add_poll_option',
        value: 'add'
      });
    }
    if (options.length > 2) {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Remove Last Option' },
        action_id: 'remove_poll_option',
        style: 'danger',
        value: 'remove'
      });
    }

    if (actionElements.length > 0) {
      blocks.push({
        type: 'actions',
        elements: actionElements
      });
    }

    // Poll settings
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Poll Settings*'
        },
        accessory: {
          type: 'checkboxes',
          action_id: 'poll_settings',
          options: [
            {
              text: {
                type: 'mrkdwn',
                text: 'Anonymous voting'
              },
              description: {
                type: 'mrkdwn',
                text: 'Hide voter names from results'
              },
              value: 'anonymous'
            },
            {
              text: {
                type: 'mrkdwn',
                text: 'Multiple choice'
              },
              description: {
                type: 'mrkdwn',
                text: 'Allow users to select multiple options'
              },
              value: 'multiple'
            }
          ],
          initial_options: (data.pollSettings || []).map(setting => ({
            text: { type: 'mrkdwn', text: setting === 'anonymous' ? 'Anonymous voting' : 'Multiple choice' },
            value: setting
          }))
        }
      }
    );

    // Navigation buttons
    blocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          { 
            type: 'button', 
            text: { type: 'plain_text', text: 'Back to Menu' }, 
            action_id: 'nav_menu' 
          },
          { 
            type: 'button', 
            style: 'primary', 
            text: { type: 'plain_text', text: 'Preview Poll' }, 
            action_id: 'nav_preview' 
          }
        ]
      }
    );

    return {
      ...base,
      title: { type: 'plain_text', text: 'Create Poll' },
      blocks: blocks
    };
  }

  // FORM PAGES
  const commonBlocks = [
    { 
      type: 'header', 
      text: { 
        type: 'plain_text', 
        text: `Step 1: Create Your ${page.charAt(0).toUpperCase() + page.slice(1)} Message` 
      }
    },
    { type: 'divider' }
  ];

  if ((page === 'capacity' || page === 'help') && !data.userModifiedText) {
    const templateInfo = page === 'capacity' ?
      'Using default capacity check template. Feel free to customize the message text below.' :
      'Using default help button template. Feel free to customize the message text below.';

    commonBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${templateInfo}*`
      }
    });
  }

  commonBlocks.push(
    ...(page !== 'capacity' && page !== 'help' ? [{
      type: 'input',
      block_id: 'title_block',
      label: { type: 'plain_text', text: 'Title (optional)' },
      element: {
        type: 'plain_text_input',
        action_id: 'title_input',
        initial_value: data.title || '',
        placeholder: { type: 'plain_text', text: 'Enter a catchy title for your message...' }
      },
      optional: true
    }] : []),
    {
      type: 'input',
      block_id: 'text_block',
      label: { type: 'plain_text', text: 'Message Text' },
      element: {
        type: 'plain_text_input',
        action_id: 'text_input',
        multiline: true,
        initial_value: getInitialTextValue(page, data),
        placeholder: { type: 'plain_text', text: 'Enter your message content here...' }
      }
    }
  );

  const actionBlocks = [{ type: 'divider' }];

  if ((page === 'capacity' || page === 'help') && data.userModifiedText) {
    actionBlocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Reset to Template' },
        action_id: `reset_template_${page}`,
        style: 'danger'
      }]
    });
  }

  actionBlocks.push({
    type: 'actions',
    elements: [
      { 
        type: 'button', 
        text: { type: 'plain_text', text: 'Back to Menu' }, 
        action_id: 'nav_menu' 
      },
      { 
        type: 'button', 
        style: 'primary', 
        text: { type: 'plain_text', text: 'Preview Message' }, 
        action_id: 'nav_preview' 
      }
    ]
  });

  return {
    ...base,
    title: { type: 'plain_text', text: `${page.charAt(0).toUpperCase() + page.slice(1)} Message` },
    submit: { type: 'plain_text', text: 'Preview Message' },
    blocks: [...commonBlocks, ...actionBlocks]
  };
}

// ================================
// POLL MESSAGE CREATION
// ================================

async function createPollMessage(data) {
  const pollId = generateId();
  const options = data.pollOptions.split('\n').filter(o => o.trim());
  const isAnonymous = data.pollSettings?.includes('anonymous') || false;
  const isMultiple = data.pollSettings?.includes('multiple') || false;

  // Initialize vote tracking
  pollVotes[pollId] = {};
  options.forEach((_, index) => {
    pollVotes[pollId][index] = new Set();
  });

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${data.title || 'Poll'}*${cat()}`
      }
    }
  ];

  if (data.question) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: data.question
      }
    });
  }

  blocks.push({ type: 'divider' });

  // Create voting buttons for each option
  options.forEach((option, index) => {
    blocks.push({
      type: 'section',
      text: {
        type:
