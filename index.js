/**
 * PM Squad Bot - Cat Scratch (Clean Version)
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
const pollVotes = {};
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

loadMessages();

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

  if (data.title && data.type !== 'capacity' && data.type !== 'help') {
    previewText += `*${data.title}*\n`;
  }

  if (data.type === 'capacity') {
    previewText += data.text || templates.capacity;
  } else if (data.type === 'poll') {
    previewText += `*${data.title || 'Poll'}*\n`;
    if (data.text) previewText += `${data.text}\n`;

    if (data.pollType === 'open') {
      previewText += '\nOpen discussion - responses in thread';
    } else if (data.pollOptions) {
      const options = data.pollOptions.split('\n').filter(o => o.trim());
      previewText += '\n' + options.map((opt, i) => `${i + 1}. ${opt.trim()}`).join('\n');

      if (data.pollSettings?.length > 0) {
        previewText += `\n\nSettings: ${data.pollSettings.join(', ')}`;
      }

      const voteType = data.pollType === 'single' ? 'Single choice' : 'Multiple choice';
      previewText += `\nType: ${voteType}`;
    }
  } else if (data.type === 'help') {
    previewText += data.text || templates.help;
    previewText += '\n\nRequest Backup (button)';
  } else {
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
            },
            { 
              type: 'button', 
              text: { type: 'plain_text', text: 'Poll' }, 
              action_id: 'nav_poll' 
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
            text: `*${msg.title || msg.type}*\n${nextRun}\n<#${msg.channel}>\n\n_${(msg.text || '').substring(0, 100)}${(msg.text || '').length > 100 ? '...' : ''}_`
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
          },
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Post Message' },
            action_id: 'submit_message'
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

  // POLL specific blocks
  if (page === 'poll') {
    try {
      commonBlocks.push(
        { type: 'divider' },
        { 
          type: 'section', 
          text: { 
            type: 'mrkdwn', 
            text: '*Poll Configuration*' 
          }
        }
      );

      const radioOptions = [
        {
          text: { type: 'plain_text', text: 'Single Choice' },
          description: { type: 'plain_text', text: 'One selection per person' },
          value: 'single'
        },
        {
          text: { type: 'plain_text', text: 'Multiple Choice' },
          description: { type: 'plain_text', text: 'Multiple selections allowed' },
          value: 'multiple'
        },
        {
          text: { type: 'plain_text', text: 'Open Discussion' },
          description: { type: 'plain_text', text: 'Thread-based responses' },
          value: 'open'
        }
      ];

      const selectedType = data.pollType || 'single';
      let initialOption = radioOptions[0];
      if (selectedType === 'multiple') {
        initialOption = radioOptions[1];
      } else if (selectedType === 'open') {
        initialOption = radioOptions[2];
      }

      commonBlocks.push({
        type: 'section',
        block_id: 'poll_type_section',
        text: { type: 'mrkdwn', text: 'How should people vote?' },
        accessory: {
          type: 'radio_buttons',
          options: radioOptions,
          initial_option: initialOption,
          action_id: 'poll_type_radio'
        }
      });

      if (data.pollType !== 'open') {
        commonBlocks.push(
          { type: 'divider' },
          { 
            type: 'section', 
            text: { 
              type: 'mrkdwn', 
              text: '*Poll Options*' 
            }
          }
        );

        const options = data.pollOptions ?
          data.pollOptions.split('\n').filter(o => o.trim()) :
          ['Option 1', 'Option 2'];

        while (options.length < 2) {
          options.push(`Option ${options.length + 1}`);
        }

        options.forEach((option, index) => {
          commonBlocks.push({
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
          commonBlocks.push({
            type: 'actions',
            elements: actionElements
          });
        }

        const availableSettings = [
          {
            text: { type: 'mrkdwn', text: '*Show vote counts*' },
            description: { type: 'mrkdwn', text: 'Display number of votes per option' },
            value: 'show_counts'
          },
          {
            text: { type: 'mrkdwn', text: '*Anonymous voting*' },
            description: { type: 'mrkdwn', text: 'Hide who voted for what' },
            value: 'anonymous'
          }
        ];

        const settingsBlock = {
          type: 'section',
          block_id: 'poll_settings_section',
          text: { type: 'mrkdwn', text: 'Display options:' },
          accessory: {
            type: 'checkboxes',
            options: availableSettings,
            action_id: 'poll_settings_checkboxes'
          }
        };

        if (data.pollSettings && data.pollSettings.length > 0) {
          const validSettings = data.pollSettings.filter(setting =>
            setting === 'show_counts' || setting === 'anonymous'
          );

          if (validSettings.length > 0) {
            settingsBlock.accessory.initial_options = validSettings.map(setting =>
              availableSettings.find(option => option.value === setting)
            ).filter(option => option);
          }
        }

        commonBlocks.push(
          { type: 'divider' },
          settingsBlock
        );
      } else {
        commonBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: "_Open discussion polls don't need predefined options. People will respond in the message thread._"
          }
        });
      }

    } catch (error) {
      console.error('Error creating poll form:', error);
      commonBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: 'Poll form error - using fallback. Please try again.' }
      });
    }
  }

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
// MESSAGE SENDING - FIXED POLL HANDLING
// ================================

async function updatePollMessage(client, channel, messageTs, pollData, votes) {
  try {
    console.log('Updating poll message:', { channel, messageTs, pollData: pollData.id });
    
    const options = (pollData.pollOptions || '').split('\n').filter(Boolean);
    const showCounts = pollData.pollSettings?.includes('show_counts') || false;
    const anonymous = pollData.pollSettings?.includes('anonymous') || false;
    
    let blocks = [
      { 
        type: 'section', 
        text: { 
          type: 'mrkdwn', 
          text: `*${pollData.title || 'Poll'}*${cat()}\n${pollData.text || ''}` 
        }
      }
    ];

    if (pollData.pollType !== 'open' && options.length > 0) {
      const buttonElements = options.map((option, idx) => {
        let buttonText = option.slice(0, 70);
        
        if (showCounts && votes[idx]) {
          const count = votes[idx].size;
          buttonText += ` (${count})`;
        }
        
        return {
          type: 'button',
          text: { type: 'plain_text', text: buttonText },
          action_id: `poll_vote_${pollData.id}_${idx}`,
          value: `${idx}`
        };
      });

      for (let i = 0; i < buttonElements.length; i += 5) {
        blocks.push({
          type: 'actions',
          block_id: `poll_${pollData.id}_${i}`,
          elements: buttonElements.slice(i, i + 5)
        });
      }
      
      if (showCounts && !anonymous) {
        let voteSummary = '';
        options.forEach((option, idx) => {
          if (votes[idx] && votes[idx].size > 0) {
            const voters = Array.from(votes[idx]).map(userId => `<@${userId}>`).join(', ');
            voteSummary += `*${option}*: ${voters}\n`;
          }
        });
        
        if (voteSummary) {
          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Votes:*\n${voteSummary}`
            }
          });
        }
      }
    }

    let contextText = pollData.pollType === 'single' ? 'Click to vote. Click again to unvote.' :
      pollData.pollType === 'multiple' ? 'Click to vote (multiple choices). Click again to unvote.' :
      'Open-ended poll. Use thread replies to respond.';
      
    if (showCounts && pollData.pollType !== 'open') {
      const totalVotes = Object.values(votes).reduce((sum, voteSet) => sum + voteSet.size, 0);
      contextText += ` • Total votes: ${totalVotes}`;
    }

    blocks.push({ 
      type: 'context', 
      elements: [{ type: 'mrkdwn', text: contextText }]
    });

    await client.chat.update({
      channel: channel,
      ts: messageTs,
      text: pollData.title || 'Poll',
      blocks: blocks
    });
    
    console.log('Poll message updated successfully');
    
  } catch (error) {
    console.error('Failed to update poll message:', error);
  }
}

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
        const reactions = ['green_circle', 'yellow_circle', 'orange_circle', 'red_circle'];
        for (const reaction of reactions) {
          try {
            await new Promise(resolve => setTimeout(resolve, 100));
            await app.client.reactions.add({
              channel: msg.channel,
              timestamp: result.ts,
              name: reaction
            });
          } catch (e) {
            console.error(`Reaction failed for ${reaction}:`, e?.data?.error || e?.message);
          }
        }
      }
    } else if (msg.type === 'poll') {
      console.log('Sending poll message...');
      const options = (msg.pollOptions || '').split('\n').map(s => s.trim()).filter(Boolean);
      console.log('Poll options:', options);
      console.log('Poll ID for buttons:', msg.id);

      // Initialize vote tracking with proper error handling
      if (!pollVotes[msg.id]) {
        pollVotes[msg.id] = {};
        for (let i = 0; i < options.length; i++) {
          pollVotes[msg.id][i] = new Set();
        }
        console.log('Initialized vote tracking for poll:', msg.id);
      }

      let blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*${msg.title || 'Poll'}*${cat()}\n${msg.text || ''}` }}
      ];

      if (msg.pollType !== 'open' && options.length > 0) {
        const buttonElements = options.map((option, idx) => {
          const actionId = `poll_vote_${msg.id}_${idx}`;
          console.log(`Creating button ${idx}: ${actionId}`);
          
          return {
            type: 'button',
            text: { type: 'plain_text', text: option.slice(0, 70) },
            action_id: actionId,
            value: `${idx}`
          };
        });

        for (let i = 0; i < buttonElements.length; i += 5) {
          blocks.push({
            type: 'actions',
            block_id: `poll_${msg.id}_${i}`,
            elements: buttonElements.slice(i, i + 5)
          });
        }
      }

      let contextText = msg.pollType === 'single' ? 'Click to vote. Click again to unvote.' :
        msg.pollType === 'multiple' ? 'Click to vote (multiple choices). Click again to unvote.' :
        'Open-ended poll. Use thread replies to respond.';

      if (msg.pollSettings?.includes('show_counts')) {
        contextText += ' • Vote counts: ON';
      }
      if (msg.pollSettings?.includes('anonymous')) {
        contextText += ' • Anonymous voting: ON';
      }

      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextText }]});

      console.log('Poll blocks being sent:', JSON.stringify(blocks, null, 2));

      const result = await app.client.chat.postMessage({
        channel: msg.channel,
        text: msg.title || 'Poll',
        blocks
      });

      if (result.ok && result.ts) {
        activePollMessages.set(result.ts, msg);
        console.log(`Stored poll metadata for message ${result.ts}:`, msg.id);
      }

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
    try {
      jobs.get(msg.id).destroy();
    } catch (_) {}
    jobs.delete(msg.id);
  }

  const [hh, mm] = msg.time.split(':').map(Number);
  let cronExpr;

  if (msg.repeat === 'daily') {
    cronExpr = `${mm} ${hh} * * *`;
  } else if (msg.repeat === 'weekly') {
    const day = new Date(msg.date).getDay();
    cronExpr = `${mm} ${hh} * * ${day}`;
  } else if (msg.repeat === 'monthly') {
    const day = msg.date.split('-')[2];
    cronExpr = `${mm} ${hh} ${day} * *`;
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
      try {
        job.destroy();
      } catch (_) {}
      jobs.delete(msg.id);
    }
  }, {
    timezone: 'America/New_York'
  });

  jobs.set(msg.id, job);
}

scheduledMessages.forEach(msg => {
  if (msg.repeat !== 'none' || !isDateTimeInPast(msg.date, msg.time)) {
    scheduleJob(msg);
  }
});

// ================================
// HANDLERS
// ================================

app.command('/cat', async ({ ack, body, client }) => {
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

// Navigation handlers
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

          data = {
            ...data,
            ...(data.type !== 'capacity' && data.type !== 'help' && {
              title: getFormValue(values, 'title_block', 'title_input') || data.title
            }),
            text: getFormValue(values, 'text_block', 'text_input') || data.text,
          };

          if (data.text && data.type) {
            data.userModifiedText = hasUserModifiedTemplate(data.type, data.text);
          }

          if (page === 'schedule' || page === 'preview') {
            data.channel = getFormValue(values, 'channel_block', 'channel_select', 'conversation') || data.channel;
            data.date = getFormValue(values, 'date_block', 'date_picker', 'date') || data.date;
            data.time = getFormValue(values, 'time_block', 'time_picker', 'time') || data.time;
            data.repeat = getFormValue(values, 'repeat_block', 'repeat_select', 'selected') || data.repeat || 'none';
          }

          if (data.type === 'poll') {
            const pollTypeBlock = values?.poll_type_section?.poll_type_radio;
            data.pollType = pollTypeBlock?.selected_option?.value || data.pollType || 'single';

            const settingsBlock = values?.poll_settings_section?.poll_settings_checkboxes;
            data.pollSettings = settingsBlock?.selected_options?.map(opt => opt.value) || data.pollSettings || [];

            if (data.pollType !== 'open') {
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
['nav_capacity', 'nav_poll', 'nav_help', 'nav_custom'].forEach(action => {
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
        } else if (messageType === 'poll') {
          data = { type: 'poll', text: '', title: '', pollType: 'single', pollOptions: 'Option 1\nOption 2', pollSettings: [], scheduleType: 'schedule' };
        } else if (messageType === 'custom') {
          data = { type: 'custom', text: '', title: '', scheduleType: 'schedule' };
        }
      } else {
        data.type = messageType;
        if (!data.text && (messageType === 'capacity' || messageType === 'help')) {
          data.text = messageType === 'capacity' ? templates.capacity : templates.help;
          data.userModifiedText = false;
        }
        if (messageType === 'poll') {
          if (!data.pollType) data.pollType = 'single';
          if (!data.pollOptions) data.pollOptions = 'Option 1\nOption 2';
          if (!data.pollSettings) data.pollSettings = [];
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
    let data = formData.get(userId) || {};
    data.scheduleType = 'now';
    formData.set(userId, data);

    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (error) {
    console.error('Timing now error:', error);
  }
});

app.action('timing_schedule', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};
    data.scheduleType = 'schedule';
    formData.set(userId, data);

    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (error) {
    console.error('Timing schedule error:', error);
  }
});

// Form input handlers
app.action('channel_select', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedChannel = body.actions[0].selected_conversation || body.actions[0].initial_conversation;
  let data = formData.get(userId) || {};
  data.channel = selectedChannel;
  formData.set(userId, data);

  try {
    const channelInfo = await client.conversations.info({ channel: selectedChannel });
    console.log(`Channel verified: #${channelInfo.channel.name}`);
  } catch (error) {
    console.error(`Channel verification failed for ${selectedChannel}`);
  }
});

app.action('date_picker', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedDate = body.actions[0].selected_date;
  let data = formData.get(userId) || {};
  data.date = selectedDate;
  data.scheduleType = 'schedule';
  formData.set(userId, data);

  try {
    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (e) {
    console.log('Could not refresh modal after date selection.');
  }
});

app.action('time_picker', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedTime = body.actions[0].selected_time;
  let data = formData.get(userId) || {};
  data.time = selectedTime;
  data.scheduleType = 'schedule';
  formData.set(userId, data);

  try {
    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (e) {
    console.log('Could not refresh modal after time selection.');
  }
});

app.action('repeat_select', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedRepeat = body.actions[0].selected_option.value;
  let data = formData.get(userId) || {};
  data.repeat = selectedRepeat;
  formData.set(userId, data);

  try {
    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (e) {
    console.log('Could not refresh modal after repeat selection.');
  }
});

app.action('alert_channels_select', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedChannels = body.actions[0].selected_conversations || body.actions[0].initial_conversations || [];
  let data = formData.get(userId) || {};
  data.alertChannels = selectedChannels;
  formData.set(userId, data);

  try {
    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (e) {
    console.log('Could not refresh modal after alert channels selection.');
  }
});

// Poll form handlers
app.action('poll_type_radio', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const selectedType = body.actions[0].selected_option.value;
    let data = formData.get(userId) || {};
    data.pollType = selectedType;

    if (selectedType === 'open') {
      data.pollOptions = '';
    }

    formData.set(userId, data);
    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Poll type radio error:', error);
  }
});

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

    if (!options[options.length - 1]) {
      options[options.length - 1] = `Option ${options.length}`;
    } else {
      options.push(`Option ${options.length + 1}`);
    }

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

app.action('poll_settings_checkboxes', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};
    const selectedOptions = body.actions[0].selected_options || [];
    data.pollSettings = selectedOptions.map(opt => opt.value);
    formData.set(userId, data);
  } catch (error) {
    console.error('Poll settings error:', error);
  }
});

// Modal submission handler
app.view(/^scheduler_.+/, async ({ ack, body, view, client }) => {
  if (body.view.callback_id === 'scheduler_schedule') {
    try {
      const userId = body.user.id;
      let data = formData.get(userId) || {};
      const values = body.view.state.values;

      const extractedChannel = getFormValue(values, 'channel_block', 'channel_select', 'conversation');
      const extractedDate = getFormValue(values, 'date_block', 'date_picker', 'date');
      const extractedTime = getFormValue(values, 'time_block', 'time_picker', 'time');
      const extractedRepeat = getFormValue(values, 'repeat_block', 'repeat_select', 'selected');

      const errors = {};

      if (!extractedChannel && !data.channel) {
        errors['channel_block'] = 'Please select a channel to post the message';
      }

      if (data.type === 'help') {
        const extractedAlertChannels = getFormValue(values, 'alert_channels_block', 'alert_channels_select', 'conversations');
        if (!extractedAlertChannels?.length && (!data.alertChannels || data.alertChannels.length === 0)) {
          errors['alert_channels_block'] = 'Please select at least one alert channel for help notifications';
        }
      }

      const scheduleType = data.scheduleType || 'schedule';
      if (scheduleType === 'schedule') {
        if (!extractedDate && !data.date) {
          errors['date_block'] = 'Please select a date for scheduling';
        }
        if (!extractedTime && !data.time) {
          errors['time_block'] = 'Please select a time for scheduling';
        }

        const finalDate = extractedDate || data.date || todayInEST();
        const finalTime = extractedTime || data.time || '09:00';
        const finalRepeat = extractedRepeat || data.repeat || 'none';

        if (finalRepeat === 'none' && isDateTimeInPast(finalDate, finalTime)) {
          errors['time_block'] = `Cannot schedule in the past. Current time: ${currentTimeInEST()} EST`;
        }
      }

      if (Object.keys(errors).length > 0) {
        await ack({ response_action: 'errors', errors: errors });
        return;
      }

      await ack();

      data = {
        ...data,
        channel: extractedChannel || data.channel,
        date: extractedDate || data.date || todayInEST(),
        time: extractedTime || data.time || '09:00',
        repeat: extractedRepeat || data.repeat || 'none'
      };

      if (data.type === 'help') {
        const extractedAlertChannels = getFormValue(values, 'alert_channels_block', 'alert_channels_select', 'conversations');
        data.alertChannels = extractedAlertChannels || data.alertChannels || [];
      }

      if (!data.id) {
        data.id = generateId();
      }

      const finalScheduleType = data.scheduleType || 'schedule';

      if (finalScheduleType === 'now') {
        const success = await sendMessage(data);
        const resultMessage = success ?
          `${data.type.charAt(0).toUpperCase() + data.type.slice(1)} message posted to <#${data.channel}>!${cat()}` :
          `Failed to post message. Please check that I'm invited to <#${data.channel}>.${cat()}`;

        try {
          await client.chat.postEphemeral({
            channel: body.user.id,
            user: userId,
            text: resultMessage
          });
        } catch (e) {
          console.log('Could not send ephemeral result message.');
        }
      } else {
        const existingIndex = scheduledMessages.findIndex(m => m.id === data.id);
        if (existingIndex >= 0) {
          scheduledMessages[existingIndex] = data;
        } else {
          scheduledMessages.push(data);
        }

        saveMessages();
        scheduleJob(data);

        const successMessage = `${data.type.charAt(0).toUpperCase() + data.type.slice(1)} message scheduled for <#${data.channel}>!${cat()}\n\n${data.date} at ${formatTimeDisplay(data.time)}\nRepeat: ${data.repeat !== 'none' ? data.repeat : 'One-time'}`;

        try {
          await client.chat.postEphemeral({
            channel: body.user.id,
            user: userId,
            text: successMessage
          });
        } catch (e) {
          console.log('Could not send ephemeral scheduling confirmation.');
        }
      }

      formData.delete(userId);
    } catch (error) {
      console.error('Error during modal processing:', error);
      await ack({
        response_action: 'errors',
        errors: { 'channel_block': 'An error occurred processing your request. Please try again.' }
      });
    }
  } else {
    await ack();
  }
});

// Delete scheduled message
app.action(/^delete_message_.+/, async ({ ack, body, client, action }) => {
  await ack();
  try {
    const msgId = action.value;
    scheduledMessages = scheduledMessages.filter(msg => msg.id !== msgId);

    if (jobs.has(msgId)) {
      try {
        jobs.get(msgId).destroy();
      } catch (_) {}
      jobs.delete(msgId);
    }

    saveMessages();
    await client.views.update({
      view_id: body.view.id,
      view: createModal('scheduled')
    });
  } catch (error) {
    console.error('Delete message error:', error);
  }
});

// FIXED POLL VOTING HANDLER WITH BETTER DEBUGGING
app.action(/^poll_vote_.+/, async ({ ack, body, client, action }) => {
  await ack();
  
  try {
    console.log('Raw action_id received:', action.action_id);
    console.log('Action value:', action.value);
    
    const actionParts = action.action_id.split('_');
    console.log('Action parts:', actionParts);
    
    if (actionParts.length < 4) {
      throw new Error(`Invalid action_id format: ${action.action_id}. Expected: poll_vote_msgId_optionIndex`);
    }
    
    const msgId = actionParts.slice(2, -1).join('_'); // Handle msgIds with underscores
    const optionId = actionParts[actionParts.length - 1];
    const optionIndex = parseInt(optionId);
    
    const user = body.user.id;
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    console.log(`Poll vote parsed: msgId=${msgId}, optionId=${optionId}, optionIndex=${optionIndex}, user=${user}, messageTs=${messageTs}`);

    if (isNaN(optionIndex)) {
      throw new Error(`Invalid option index: ${optionId} is not a number`);
    }

    // Find poll data
    let pollData = scheduledMessages.find(m => m.id === msgId);
    if (!pollData && messageTs) {
      pollData = activePollMessages.get(messageTs);
    }
    
    // If still not found, try to reconstruct from message
    if (!pollData && body.message?.blocks) {
      console.log('Poll data not found in storage, attempting to reconstruct from message');
      
      const buttonBlocks = body.message.blocks.filter(block => block.type === 'actions');
      const extractedOptions = [];
      
      buttonBlocks.forEach(block => {
        block.elements?.forEach(element => {
          if (element.type === 'button' && element.action_id?.startsWith('poll_vote_')) {
            extractedOptions.push(element.text.text.replace(/ \(\d+\)$/, ''));
          }
        });
      });
      
      if (extractedOptions.length > 0) {
        pollData = {
          id: msgId,
          pollOptions: extractedOptions.join('\n'),
          pollType: 'single',
          pollSettings: ['show_counts'],
          title: 'Poll',
          text: ''
        };
        
        activePollMessages.set(messageTs, pollData);
        console.log('Reconstructed poll data from message');
      }
    }

    if (!pollData) {
      console.error(`Poll data not found for msgId: ${msgId}`);
      try {
        await client.chat.postEphemeral({
          channel: channel || user,
          user: user,
          text: 'Poll data not found. Please try refreshing or contact an admin if this persists.'
        });
      } catch (e) {
        console.log('Could not send poll not found message.');
      }
      return;
    }

    const options = (pollData.pollOptions || '').split('\n').filter(Boolean);
    console.log(`Poll options:`, options);
    console.log(`Poll data ID:`, pollData.id);

    // CRITICAL FIX: Initialize vote tracking completely
    if (!pollVotes[msgId]) {
      pollVotes[msgId] = {};
      console.log(`Created new vote tracking for msgId: ${msgId}`);
    }

    // Ensure ALL option indices exist as Sets
    for (let i = 0; i < options.length; i++) {
      if (!pollVotes[msgId][i]) {
        pollVotes[msgId][i] = new Set();
        console.log(`Created vote set for option ${i}`);
      }
    }

    // Validate option index
    if (optionIndex < 0 || optionIndex >= options.length) {
      console.error(`Invalid option index: ${optionIndex} for poll with ${options.length} options`);
      try {
        await client.chat.postEphemeral({
          channel: channel || user,
          user: user,
          text: 'Invalid poll option. Please try again.'
        });
      } catch (e) {
        console.log('Could not send invalid option message.');
      }
      return;
    }

    // Double-check that the specific option exists
    if (!pollVotes[msgId][optionIndex]) {
      pollVotes[msgId][optionIndex] = new Set();
      console.log(`Created missing vote set for option ${optionIndex}`);
    }

    console.log(`Vote tracking state for ${msgId}:`, Object.keys(pollVotes[msgId]));

    const pollType = pollData.pollType || 'single';
    let userVoteChanged = false;

    if (pollType === 'single') {
      const wasVotedHere = pollVotes[msgId][optionIndex].has(user);
      
      // Remove user from all options
      Object.values(pollVotes[msgId]).forEach(set => {
        if (set && typeof set.delete === 'function') {
          set.delete(user);
        }
      });
      
      // If they weren't already voted here, add their vote
      if (!wasVotedHere) {
        pollVotes[msgId][optionIndex].add(user);
      }
      userVoteChanged = true;
      
    } else if (pollType === 'multiple') {
      if (pollVotes[msgId][optionIndex].has(user)) {
        pollVotes[msgId][optionIndex].delete(user);
        console.log(`Removed vote from option ${optionIndex}`);
      } else {
        pollVotes[msgId][optionIndex].add(user);
        console.log(`Added vote to option ${optionIndex}`);
      }
      userVoteChanged = true;
    }

    // Update the poll message with new vote counts
    if (userVoteChanged && messageTs && channel) {
      await updatePollMessage(client, channel, messageTs, pollData, pollVotes[msgId]);
    }

    // Send confirmation to user
    try {
      const voteStatus = pollType === 'single' ? 
        (pollVotes[msgId][optionIndex].has(user) ? 'Vote recorded' : 'Vote removed') :
        (pollVotes[msgId][optionIndex].has(user) ? 'Vote added' : 'Vote removed');
        
      await client.chat.postEphemeral({
        channel: channel || user,
        user: user,
        text: `${voteStatus}!`
      });
    } catch (epErr) {
      console.log('Could not send ephemeral vote confirmation.');
    }

    console.log(`Vote processed for user ${user} on poll ${msgId}`);
    
  } catch (error) {
    console.error('Poll vote error:', error);
    console.error('Error stack:', error.stack);
    
    try {
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: body.user.id,
        text: 'There was an error processing your vote. Please try again.'
      });
    } catch (e) {
      console.log('Could not send error message to user.');
    }
  }
});

// Help button handler
app.action(/^help_click_.+/, async ({ ack, body, client, action }) => {
  await ack();
  try {
    const actionData = JSON.parse(action.value);
    const msgId = actionData.msgId;
    const alertChannels = actionData.alertChannels || [];
    const user = body.user.id;
    const channel = body.channel?.id || null;

    if (!alertChannels || alertChannels.length === 0) {
      try {
        await client.chat.postEphemeral({
          channel: channel || user,
          user,
          text: 'No alert channels configured for this help button.'
        });
      } catch (e) {
        console.log('Could not post ephemeral help warning.');
      }
      return;
    }

    let successCount = 0;
    const alertPromises = alertChannels.map(async (alertChannel) => {
      try {
        await client.chat.postMessage({
          channel: alertChannel,
          text: `<@${user}> needs backup in ${channel ? `<#${channel}>` : 'this area'}`,
          unfurl_links: false,
          unfurl_media: false
        });
        successCount++;
      } catch (e) {
        console.error(`Alert failed for channel ${alertChannel}:`, e);
      }
    });

    await Promise.all(alertPromises);

    try {
      await client.chat.postEphemeral({
        channel: channel || user,
        user,
        text: `Backup request sent to ${successCount}/${alertChannels.length} alert channels.${cat()}`
      });
    } catch (e) {
      console.log('Could not post ephemeral confirmation.');
    }

    console.log(`Backup request from ${user} sent to ${successCount}/${alertChannels.length} alert channels`);
  } catch (error) {
    console.error('Help button error:', error);
  }
});

// Debug commands
app.command('/cat-debug', async ({ ack, body, client }) => {
  await ack();

  const channelId = body.channel_id;
  const userId = body.user_id;

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: 'Running debug tests... check console for details'
  });

  try {
    const authTest = await client.auth.test();
    const channelInfo = await client.conversations.info({ channel: channelId });
    const testResult = await client.chat.postMessage({
      channel: channelId,
      text: 'Debug test message - if you see this, posting works!'
    });

    if (testResult.ok) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'Debug complete - message posting works! Test message will be deleted in 5 seconds.'
      });

      setTimeout(async () => {
        try {
          await client.chat.delete({
            channel: channelId,
            ts: testResult.ts
          });
        } catch (e) {
          console.log('Note: Could not delete test message');
        }
      }, 5000);
    }
  } catch (error) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'Debug failed - check console for details'
    });
  }
});

app.command('/cat-form-debug', async ({ ack, body, client }) => {
  await ack();

  const userId = body.user_id;
  const userData = formData.get(userId);

  await client.chat.postEphemeral({
    channel: body.channel_id,
    user: userId,
    text: `Form Data Debug:\n\`\`\`${JSON.stringify(userData, null, 2) || 'No data found'}\`\`\`\n\nFormData Size: ${formData.size} users`
  });
});

// Error handling
app.error((error) => {
  console.error('Global error:', error);
});

// Cleanup expired messages
cron.schedule('0 * * * *', () => {
  const beforeCount = scheduledMessages.length;
  scheduledMessages = scheduledMessages.filter(msg => {
    if (msg.repeat !== 'none') return true;

    const isPast = isDateTimeInPast(msg.date, msg.time);
    if (isPast) {
      if (jobs.has(msg.id)) {
        try {
          jobs.get(msg.id).destroy();
        } catch (_) {}
        jobs.delete(msg.id);
      }
    }

    return !isPast;
  });

  if (scheduledMessages.length !== beforeCount) {
    saveMessages();
    console.log(`${cat()} Cleaned up ${beforeCount - scheduledMessages.length} expired messages`);
  }
}, {
  timezone: 'America/New_York'
});

// Startup
(async () => {
  try {
    const keepAliveServer = require('http').createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('PM Squad Bot is running!');
    });

    const PORT = process.env.PORT || 3000;
    keepAliveServer.listen(PORT, () => {
      console.log(`Keep-alive server running on port ${PORT}`);
    });

    await app.start();
    
    console.log('PM Squad Bot "Cat Scratch" is running! (Clean Version)');
    console.log(`Loaded ${scheduledMessages.length} scheduled messages`);
    console.log(`Active jobs: ${jobs.size}`);
    console.log(`Current EST time: ${currentTimeInEST()}`);
    console.log(`Current EST date: ${todayInEST()}`);

    if (scheduledMessages.length > 0) {
      console.log('Scheduled Messages:');
      scheduledMessages.forEach(msg => {
        const nextRun = msg.repeat === 'none' ?
          `${msg.date} at ${msg.time}` :
          `${msg.repeat} at ${msg.time}`;
        console.log(`  - ${msg.type}: ${nextRun} -> #${msg.channel}`);
      });
    }

    console.log('All systems ready! Use /cat to start.');
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();

process.on('SIGINT', () => {
  console.log(`${cat()} Shutting down, cleaning up jobs...`);
  jobs.forEach(job => job.destroy());
  process.exit(0);
});
