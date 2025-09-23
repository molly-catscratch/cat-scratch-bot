/**
 * PM Squad Bot - Cat Scratch (Enhanced Complete Version)
 * Features: Multiple slash commands, App Home, Enhanced polling, All original functionality
 * Flow: Menu → Form → Preview → Schedule → Send/Schedule
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
const USER_DATA_FILE = './userData.json';
let scheduledMessages = [];
let userData = {};
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

function saveUserData() {
  try {
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(userData, null, 2));
  } catch (e) {
    console.error('User data save failed:', e);
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

function loadUserData() {
  if (fs.existsSync(USER_DATA_FILE)) {
    try {
      userData = JSON.parse(fs.readFileSync(USER_DATA_FILE));
    } catch (e) {
      console.error('User data load failed:', e);
      userData = {};
    }
  }
}

loadMessages();
loadUserData();

// ================================
// USER DATA MANAGEMENT
// ================================

function getUserData(userId) {
  if (!userData[userId]) {
    userData[userId] = {
      firstSeen: new Date().toISOString(),
      totalMessages: 0,
      lastUsed: new Date().toISOString(),
      isExperienced: false
    };
    saveUserData();
  }
  return userData[userId];
}

function updateUserActivity(userId) {
  const user = getUserData(userId);
  user.lastUsed = new Date().toISOString();
  user.totalMessages = (user.totalMessages || 0) + 1;
  user.isExperienced = user.totalMessages >= 3;
  saveUserData();
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

    if (data.pollOptions) {
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
// APP HOME VIEW
// ================================

function createAppHome(userId) {
  const user = getUserData(userId);
  const userMessages = scheduledMessages.filter(msg => msg.createdBy === userId);
  
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Welcome to Cat Scratch!*\n\nYour friendly neighborhood bot for PM team communications. I help you create capacity checks, help buttons, polls, and custom messages - all with the scheduling power of a cat with a very organized calendar.`
      }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Quick Actions*\nJump right into creating messages:'
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Capacity Check' },
          action_id: 'home_capacity'
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Help Button' },
          action_id: 'home_help'
        }
      ]
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Create Poll' },
          action_id: 'home_poll'
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Custom Message' },
          action_id: 'home_custom'
        }
      ]
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Slash Commands*\nBecause sometimes typing is faster than clicking:'
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '`/cat` - Opens the main menu for creating any type of message\n`/capacity` - Quick capacity check creation\n`/help` - Create a help button for your team\n`/manage` - View and manage your scheduled messages'
      }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*What Can I Do?*'
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Capacity Checks* - Get quick team bandwidth updates with reaction-based responses\n*Help Buttons* - Let team members call for backup when they need it\n*Polls* - Create single or multiple choice polls with real-time voting\n*Custom Messages* - Send any message, with or without scheduling\n*Smart Scheduling* - Post now, schedule for later, or set up recurring messages'
      }
    }
  ];

  // Show management section if user has scheduled messages
  if (scheduledMessages.length > 0) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Message Management*\nYou have ${userMessages.length} scheduled message${userMessages.length !== 1 ? 's' : ''} (${scheduledMessages.length} total across your team)`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Manage Messages' },
          action_id: 'home_manage'
        }
      }
    );
  }

  // Add getting started tip for new users
  if (!user.isExperienced) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*New to Cat Scratch?*\nStart with a quick `/capacity` command to see how easy team communication can be. Like a cat, I make everything look effortless.'
        }
      }
    );
  }

  return {
    type: 'home',
    blocks
  };
}

// ================================
// MODAL CREATION - ENHANCED
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
            text: 'Create New Message' 
          }
        },
        { type: 'divider' },
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
              style: 'danger',
              text: { type: 'plain_text', text: 'Help Button' }, 
              action_id: 'nav_help' 
            }
          ]
        },
        {
          type: 'actions',
          elements: [
            { 
              type: 'button', 
              text: { type: 'plain_text', text: 'Create Poll' }, 
              action_id: 'nav_poll' 
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
          type: 'header', 
          text: { 
            type: 'plain_text', 
            text: 'Message Management' 
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

    if (data.scheduleType === 'schedule') {
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

  // ENHANCED POLL BLOCKS
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
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*How should people vote?*'
          }
        },
        {
          type: 'input',
          block_id: 'poll_type_section',
          label: { type: 'plain_text', text: 'Voting Type' },
          element: {
            type: 'radio_buttons',
            action_id: 'poll_type_radio',
            initial_option: data.pollType === 'single' ?
              { text: { type: 'plain_text', text: '🔘 Single choice - voters pick one option' }, value: 'single' } :
              { text: { type: 'plain_text', text: '🔲 Multiple choice - voters can pick several options' }, value: 'multiple' },
            options: [
              { text: { type: 'plain_text', text: '🔘 Single choice - voters pick one option' }, value: 'single' },
              { text: { type: 'plain_text', text: '🔲 Multiple choice - voters can pick several options' }, value: 'multiple' }
            ]
          }
        },
        {
          type: 'input',
          block_id: 'poll_settings_section',
          label: { type: 'plain_text', text: 'Poll Settings (optional)' },
          element: {
            type: 'checkboxes',
            action_id: 'poll_settings_checkboxes',
            initial_options: data.pollSettings?.filter(setting => setting !== 'anonymous').map(setting => ({
              text: { 
                type: 'plain_text', 
                text: setting === 'hidden' ? '👁️‍🗨️ Hide results until poll closes' :
                      setting === 'limited' ? '📊 Limit votes per person' :
                      setting === 'allow_add' ? '➕ Let others add options' : setting
              },
              value: setting
            })) || [],
            options: [
              { text: { type: 'plain_text', text: '👁️‍🗨️ Hide results until poll closes' }, value: 'hidden' },
              { text: { type: 'plain_text', text: '📊 Limit votes per person' }, value: 'limited' },
              { text: { type: 'plain_text', text: '➕ Let others add options' }, value: 'allow_add' }
            ]
          },
          optional: true
        }
      );

      // Vote limit input (conditional)
      if (data.pollSettings?.includes('limited')) {
        commonBlocks.push({
          type: 'input',
          block_id: 'vote_limit_section',
          label: { type: 'plain_text', text: 'Maximum votes per person' },
          element: {
            type: 'number_input',
            action_id: 'vote_limit_input',
            initial_value: data.limit?.toString() || '1',
            min_value: '1',
            max_value: '10'
          }
        });
      }

      // Poll options section
      commonBlocks.push(
        { type: 'divider' },
        { 
          type: 'section', 
          text: { 
            type: 'mrkdwn', 
            text: '*Poll Options*\nAdd 2-10 options for people to vote on:' 
          }
        }
      );

      const options = data.pollOptions ?
        data.pollOptions.split('\n').filter(o => o.trim()) :
        ['', ''];

      // Ensure we have at least 2 options
      while (options.length < 2) {
        options.push('');
      }

      options.forEach((option, index) => {
        commonBlocks.push({
          type: 'input',
          block_id: `option_${index}_block`,
          label: { type: 'plain_text', text: `${index + 1}.` },
          element: {
            type: 'plain_text_input',
            action_id: `option_${index}_input`,
            initial_value: option || '',
            placeholder: { type: 'plain_text', text: `Enter option ${index + 1}...` }
          },
          optional: index >= 2
        });
      });

      // Dynamic option management buttons
      const actionElements = [];

      if (options.length < 10) {
        actionElements.push({
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: '➕ Add Option' },
          action_id: 'add_poll_option',
          value: 'add'
        });
      }

      if (options.length > 2) {
        actionElements.push({
          type: 'button',
          text: { type: 'plain_text', text: '➖ Remove Last' },
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

      // Preview section
      if (data.pollOptions && data.pollOptions.trim()) {
        const previewOptions = data.pollOptions.split('\n').filter(o => o.trim());
        if (previewOptions.length >= 2) {
          commonBlocks.push(
            { type: 'divider' },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*Preview:*'
              }
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*${data.title || 'Poll Question'}*\n${data.text || ''}\n\n${previewOptions.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}\n\n_${data.pollType === 'single' ? '🔘 Single choice' : '🔲 Multiple choice'} poll_`
              }
            }
          );
        }
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
// ENHANCED POLL MESSAGE HANDLING
// ================================

async function updatePollMessage(client, channel, messageTs, pollData, votes) {
  try {
    console.log('Updating poll message:', { channel, messageTs, pollData: pollData.id });
    
    const options = (pollData.pollOptions || '').split('\n').filter(Boolean);
    const showCounts = pollData.pollSettings?.includes('show_counts') !== false; // Default to true
    const isHidden = pollData.pollSettings?.includes('hidden') || false;
    const isLimited = pollData.pollSettings?.includes('limited') || false;
    const limit = pollData.limit || 1;
    const isClosed = pollData.isClosed || false;
    
    let blocks = [
      { 
        type: 'section', 
        text: { 
          type: 'mrkdwn', 
          text: `*${pollData.title || 'Poll'}*${cat()}`
        },
        accessory: {
          type: 'overflow',
          action_id: 'poll_menu',
          options: [
            {
              text: { type: 'plain_text', text: isHidden ? 'Reveal Results' : 'Hide Results' },
              value: JSON.stringify({ action: 'toggle_hidden', pollId: pollData.id, createdBy: pollData.createdBy })
            },
            {
              text: { type: 'plain_text', text: isClosed ? 'Reopen Poll' : 'Close Poll' },
              value: JSON.stringify({ action: 'toggle_closed', pollId: pollData.id, createdBy: pollData.createdBy })
            },
            {
              text: { type: 'plain_text', text: 'View All Votes' },
              value: JSON.stringify({ action: 'view_votes', pollId: pollData.id, createdBy: pollData.createdBy })
            },
            {
              text: { type: 'plain_text', text: 'Delete Poll' },
              value: JSON.stringify({ action: 'delete_poll', pollId: pollData.id, createdBy: pollData.createdBy })
            }
          ]
        }
      }
    ];

    if (pollData.text) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: pollData.text
        }
      });
    }

    // Poll status indicators
    let statusElements = [];
    if (pollData.pollType === 'single') {
      statusElements.push({ type: 'mrkdwn', text: '🔘 Single choice' });
    } else {
      statusElements.push({ type: 'mrkdwn', text: '🔲 Multiple choice' });
    }
    
    if (isLimited) {
      statusElements.push({ type: 'mrkdwn', text: `📊 Max ${limit} choice${limit !== 1 ? 's' : ''}` });
    }
    
    if (isHidden) {
      statusElements.push({ type: 'mrkdwn', text: '👁️‍🗨️ Results hidden' });
    }
    
    if (isClosed) {
      statusElements.push({ type: 'mrkdwn', text: '🔒 Poll closed' });
    }
    
    statusElements.push({ type: 'mrkdwn', text: `👤 Created by <@${pollData.createdBy}>` });

    blocks.push({
      type: 'context',
      elements: statusElements
    });

    blocks.push({ type: 'divider' });

    if (options.length > 0) {
      // Enhanced option blocks with vote buttons and real-time counts
      options.forEach((option, idx) => {
        const voteCount = votes[idx] ? votes[idx].size : 0;
        const voters = votes[idx] ? Array.from(votes[idx]) : [];
        
        // Create vote button with different styles based on poll state
        let buttonStyle = undefined;
        let buttonText = 'Vote';
        
        if (isClosed) {
          buttonText = 'Closed';
        }
        
        // Option section with vote button
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${idx + 1}.* ${option}`
          },
          accessory: {
            type: 'button',
            text: {
              type: 'plain_text',
              text: buttonText
            },
            style: buttonStyle,
            action_id: isClosed ? 'poll_closed' : `poll_vote_${pollData.id}_${idx}`,
            value: JSON.stringify({ 
              optionIndex: idx, 
              pollId: pollData.id, 
              pollType: pollData.pollType,
              isLimited: isLimited,
              limit: limit
            })
          }
        });

        // Vote display logic
        if (isHidden && !isClosed) {
          blocks.push({
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: '👁️ Results hidden until poll closes'
            }]
          });
        } else if (voteCount === 0) {
          blocks.push({
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: '📊 No votes yet'
            }]
          });
        } else {
          // Show vote count and voters
          const countText = `📊 ${voteCount} vote${voteCount !== 1 ? 's' : ''}`;
          const voterText = voters.length > 0 ? voters.map(userId => `<@${userId}>`).join(', ') : '';
          
          if (voterText) {
            blocks.push({
              type: 'context',
              elements: [{
                type: 'mrkdwn',
                text: `${countText}: ${voterText}`
              }]
            });
          } else {
            blocks.push({
              type: 'context',
              elements: [{
                type: 'mrkdwn',
                text: countText
              }]
            });
          }
        }
      });
    }

    blocks.push({ type: 'divider' });

    // Enhanced footer with comprehensive poll info
    const totalVotes = Object.values(votes).reduce((sum, voteSet) => sum + voteSet.size, 0);
    const totalVoters = new Set(Object.values(votes).flatMap(voteSet => Array.from(voteSet))).size;
    const voteTypeText = pollData.pollType === 'single' ? 'Single choice' : 'Multiple choice';
    
    let footerText = `${voteTypeText} • ${totalVotes} total vote${totalVotes !== 1 ? 's' : ''} from ${totalVoters} voter${totalVoters !== 1 ? 's' : ''}`;
    
    if (!isClosed) {
      footerText += ' • Click vote button to vote, click again to remove vote';
    }
    
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: footerText
      }]
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

// ================================
// MESSAGE SENDING - ENHANCED
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
        const reactions = ['green_circle', 'large_yellow_circle', 'large_orange_circle', 'red_circle'];
        for (const reaction of reactions) {
          try {
            await app.client.reactions.add({
              channel: msg.channel,
              timestamp: result.ts,
              name: reaction
            });
          } catch (e) {
            console.error(`Reaction failed for :${reaction}:`, e?.data?.error || e?.message);
          }
        }
      }
    } else if (msg.type === 'poll') {
      console.log('Sending enhanced poll message...');
      const options = (msg.pollOptions || '').split('\n').map(s => s.trim()).filter(Boolean);
      console.log('Poll options:', options);
      console.log('Poll ID for buttons:', msg.id);

      // Initialize vote tracking
      if (!pollVotes[msg.id]) {
        pollVotes[msg.id] = {};
        for (let i = 0; i < options.length; i++) {
          pollVotes[msg.id][i] = new Set();
        }
        console.log('Initialized vote tracking for poll:', msg.id);
      }

      let blocks = [
        { 
          type: 'section', 
          text: { 
            type: 'mrkdwn', 
            text: `*${msg.title || 'Poll'}*${cat()}`
          }
        }
      ];

      if (msg.text) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: msg.text
          }
        });
      }

      blocks.push({ type: 'divider' });

      // Enhanced option blocks
      options.forEach((option, idx) => {
        const actionId = `poll_vote_${msg.id}_${idx}`;
        console.log(`Creating button ${idx}: ${actionId}`);
        
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
              text: 'Vote'
            },
            action_id: actionId,
            value: `${idx}`
          }
        });

        blocks.push({
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: 'No votes'
          }]
        });
      });

      blocks.push({ type: 'divider' });

      const voteTypeText = msg.pollType === 'single' ? 'Single choice' : 'Multiple choice';
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${voteTypeText} poll • 0 total votes • Click again to unvote`
        }]
      });

      console.log('Enhanced poll blocks being sent:', JSON.stringify(blocks, null, 2));

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
// SLASH COMMANDS - ENHANCED
// ================================

// Main menu command
app.command('/cat', async ({ ack, body, client }) => {
  await ack();
  updateUserActivity(body.user_id);
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: createModal('menu')
    });
  } catch (error) {
    console.error('Failed to open modal:', error);
  }
});

// Direct message type commands
app.command('/capacity', async ({ ack, body, client }) => {
  await ack();
  updateUserActivity(body.user_id);
  try {
    const userId = body.user_id;
    const data = { 
      type: 'capacity', 
      text: templates.capacity, 
      userModifiedText: false, 
      scheduleType: 'schedule' 
    };
    formData.set(userId, data);
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: createModal('capacity', data)
    });
  } catch (error) {
    console.error('Failed to open capacity modal:', error);
  }
});

app.command('/help', async ({ ack, body, client }) => {
  await ack();
  updateUserActivity(body.user_id);
  try {
    const userId = body.user_id;
    const data = { 
      type: 'help', 
      text: templates.help, 
      userModifiedText: false, 
      alertChannels: [], 
      scheduleType: 'schedule' 
    };
    formData.set(userId, data);
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: createModal('help', data)
    });
  } catch (error) {
    console.error('Failed to open help modal:', error);
  }
});

app.command('/manage', async ({ ack, body, client }) => {
  await ack();
  updateUserActivity(body.user_id);
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: createModal('scheduled')
    });
  } catch (error) {
    console.error('Failed to open management modal:', error);
  }
});

// ================================
// APP HOME EVENTS
// ================================

app.event('app_home_opened', async ({ event, client }) => {
  updateUserActivity(event.user);
  try {
    await client.views.publish({
      user_id: event.user,
      view: createAppHome(event.user)
    });
  } catch (error) {
    console.error('Error publishing home view:', error);
  }
});

// Home action handlers
['home_capacity', 'home_help', 'home_poll', 'home_custom', 'home_manage'].forEach(action => {
  app.action(action, async ({ ack, body, client }) => {
    await ack();
    updateUserActivity(body.user.id);
    
    try {
      const actionType = action.replace('home_', '');
      const userId = body.user.id;
      console.log(`Home action triggered: ${action} -> ${actionType} for user ${userId}`);
      
      let data = {};
      
      if (actionType === 'capacity') {
        data = { type: 'capacity', text: templates.capacity, userModifiedText: false, scheduleType: 'schedule' };
      } else if (actionType === 'help') {
        data = { type: 'help', text: templates.help, userModifiedText: false, alertChannels: [], scheduleType: 'schedule' };
      } else if (actionType === 'poll') {
        data = { 
          type: 'poll', 
          text: '', 
          title: '', 
          pollType: 'multiple', 
          pollOptions: 'Option 1\nOption 2', 
          pollSettings: [], 
          scheduleType: 'schedule' 
        };
        console.log('Home poll data initialized:', data);
      } else if (actionType === 'custom') {
        data = { type: 'custom', text: '', title: '', scheduleType: 'schedule' };
      } else if (actionType === 'manage') {
        await client.views.open({
          trigger_id: body.trigger_id,
          view: createModal('scheduled')
        });
        return;
      }
      
      formData.set(userId, data);
      console.log(`Home calling createModal(${actionType}, data)`);
      
      await client.views.open({
        trigger_id: body.trigger_id,
        view: createModal(actionType, data)
      });
      
      console.log(`Home modal opened successfully for ${actionType}`);
    } catch (error) {
      console.error(`Failed to handle home action ${action}:`, error);
      console.error('Error stack:', error.stack);
    }
  });
});

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
            data.pollType = pollTypeBlock?.selected_option?.value || data.pollType || 'multiple';

            const settingsBlock = values?.poll_settings_section?.poll_settings_checkboxes;
            data.pollSettings = settingsBlock?.selected_options?.map(opt => opt.value) || data.pollSettings || [];

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
          data = { type: 'poll', text: '', title: '', pollType: 'multiple', pollOptions: 'Option 1\nOption 2', pollSettings: [], scheduleType: 'schedule' };
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
          if (!data.pollType) data.pollType = 'multiple';
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

// Enhanced poll form handlers
app.action('poll_type_radio', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const selectedType = body.actions[0].selected_option.value;
    let data = formData.get(userId) || {};
    data.pollType = selectedType;
    formData.set(userId, data);
    
    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Poll type radio error:', error);
  }
});

// Enhanced poll form handlers
app.action('poll_type_radio', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const selectedType = body.actions[0].selected_option.value;
    let data = formData.get(userId) || {};
    data.pollType = selectedType;
    formData.set(userId, data);
    
    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Poll type radio error:', error);
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
    
    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Poll settings error:', error);
  }
});

app.action('vote_limit_input', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};
    const limitValue = body.actions[0].value;
    data.limit = parseInt(limitValue) || 1;
    formData.set(userId, data);
  } catch (error) {
    console.error('Vote limit input error:', error);
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

    // Ensure current options are saved
    while (options.length < index) {
      options.push('');
    }
    
    options.push(''); // Add new empty option

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

// Enhanced Poll Management Actions
app.action('poll_menu', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const selectedOption = body.actions[0].selected_option;
    const actionData = JSON.parse(selectedOption.value);
    const user = body.user.id;
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    // Check if user is authorized for this action
    if (actionData.createdBy !== user) {
      await client.chat.postEphemeral({
        channel: channel || user,
        user: user,
        text: 'Only the poll creator can perform this action.'
      });
      return;
    }

    const pollData = activePollMessages.get(messageTs);
    if (!pollData) {
      await client.chat.postEphemeral({
        channel: channel || user,
        user: user,
        text: 'Poll data not found. The poll may have been deleted.'
      });
      return;
    }

    switch (actionData.action) {
      case 'toggle_hidden':
        await togglePollHidden(client, channel, messageTs, pollData, user);
        break;
      case 'toggle_closed':
        await togglePollClosed(client, channel, messageTs, pollData, user);
        break;
      case 'view_votes':
        await showVotesSummary(client, body.trigger_id, messageTs, pollData);
        break;
      case 'delete_poll':
        await confirmDeletePoll(client, body.trigger_id, messageTs, pollData, user);
        break;
    }
  } catch (error) {
    console.error('Poll menu error:', error);
  }
});

// Poll Management Functions
async function togglePollHidden(client, channel, messageTs, pollData, userId) {
  try {
    pollData.pollSettings = pollData.pollSettings || [];
    const isHidden = pollData.pollSettings.includes('hidden');
    
    if (isHidden) {
      pollData.pollSettings = pollData.pollSettings.filter(s => s !== 'hidden');
    } else {
      pollData.pollSettings.push('hidden');
    }
    
    activePollMessages.set(messageTs, pollData);
    await updatePollMessage(client, channel, messageTs, pollData, pollVotes[pollData.id] || {});
    
    await client.chat.postEphemeral({
      channel: channel,
      user: userId,
      text: isHidden ? 'Poll results are now visible!' : 'Poll results are now hidden!'
    });
  } catch (error) {
    console.error('Toggle hidden error:', error);
  }
}

async function togglePollClosed(client, channel, messageTs, pollData, userId) {
  try {
    pollData.isClosed = !pollData.isClosed;
    activePollMessages.set(messageTs, pollData);
    await updatePollMessage(client, channel, messageTs, pollData, pollVotes[pollData.id] || {});
    
    await client.chat.postEphemeral({
      channel: channel,
      user: userId,
      text: pollData.isClosed ? 'Poll has been closed!' : 'Poll has been reopened!'
    });
  } catch (error) {
    console.error('Toggle closed error:', error);
  }
}

async function showVotesSummary(client, triggerId, messageTs, pollData) {
  try {
    const votes = pollVotes[pollData.id] || {};
    const options = (pollData.pollOptions || '').split('\n').filter(Boolean);
    
    let blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Vote Summary: ${pollData.title}*`
        }
      },
      { type: 'divider' }
    ];

    const totalVotes = Object.values(votes).reduce((sum, voteSet) => sum + (voteSet?.size || 0), 0);
    const totalVoters = new Set(Object.values(votes).flatMap(voteSet => Array.from(voteSet || []))).size;
    
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📊 *${totalVotes}* total votes from *${totalVoters}* voters`
      }
    });

    blocks.push({ type: 'divider' });

    options.forEach((option, idx) => {
      const voteCount = votes[idx]?.size || 0;
      const voters = votes[idx] ? Array.from(votes[idx]) : [];
      const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
      
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${idx + 1}. ${option}*\n${voteCount} votes (${percentage}%)`
        }
      });
      
      if (voters.length > 0) {
        blocks.push({
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: voters.map(userId => `<@${userId}>`).join(', ')
          }]
        });
      }
    });

    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Vote Summary' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: blocks
      }
    });
  } catch (error) {
    console.error('Show votes summary error:', error);
  }
}

async function confirmDeletePoll(client, triggerId, messageTs, pollData, userId) {
  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'confirm_delete_poll',
        private_metadata: JSON.stringify({ messageTs, pollId: pollData.id, userId }),
        title: { type: 'plain_text', text: 'Delete Poll?' },
        submit: { type: 'plain_text', text: 'Delete' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Are you sure you want to delete the poll "*${pollData.title}*"?\n\nThis action cannot be undone.`
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Confirm delete poll error:', error);
  }
}

// Handle poll deletion confirmation
app.view('confirm_delete_poll', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const metadata = JSON.parse(view.private_metadata);
    const { messageTs, pollId, userId } = metadata;
    
    // Remove from active polls
    activePollMessages.delete(messageTs);
    
    // Remove vote data
    delete pollVotes[pollId];
    
    await client.chat.postEphemeral({
      channel: body.user.id,
      user: userId,
      text: 'Poll has been deleted successfully!'
    });
  } catch (error) {
    console.error('Delete poll confirmation error:', error);
  }
});

// Handle when someone tries to vote on a closed poll
app.action('poll_closed', async ({ ack, body, client }) => {
  await ack();
  
  await client.chat.postEphemeral({
    channel: body.channel?.id || body.user.id,
    user: body.user.id,
    text: 'This poll has been closed and is no longer accepting votes.'
  });
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
        repeat: extractedRepeat || data.repeat || 'none',
        createdBy: userId
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

      // Update user activity
      updateUserActivity(userId);
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

// ENHANCED POLL VOTING HANDLER
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
    
    const msgId = actionParts.slice(2, -1).join('_');
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
      
      let reconstructedTitle = 'Poll';
      let reconstructedText = '';
      const extractedOptions = [];
      
      body.message.blocks.forEach(block => {
        if (block.type === 'section' && block.text?.text && !reconstructedTitle.includes('*')) {
          const titleMatch = block.text.text.match(/\*(.+?)\*/);
          if (titleMatch) {
            reconstructedTitle = titleMatch[1].replace(/₍\^. \.\^\�/, '').trim();
          }
        }
        
        if (block.type === 'section' && block.text?.text && !block.text.text.includes('*') && !block.accessory) {
          reconstructedText = block.text.text;
        }
        
        if (block.type === 'section' && block.accessory?.type === 'button') {
          const optionText = block.text.text.replace(/\*(.+?)\*/, '$1').trim();
          if (optionText && !extractedOptions.includes(optionText)) {
            extractedOptions.push(optionText);
          }
        }
      });
      
      if (extractedOptions.length > 0) {
        pollData = {
          id: msgId,
          pollOptions: extractedOptions.join('\n'),
          pollType: 'multiple',
          pollSettings: [],
          title: reconstructedTitle,
          text: reconstructedText
        };
        
        activePollMessages.set(messageTs, pollData);
        console.log('Reconstructed poll data:', pollData);
      }
    }

    if (!pollData) {
      console.error(`Poll data not found for msgId: ${msgId}`);
      console.log('Available active polls:', Array.from(activePollMessages.keys()));
      console.log('Available scheduled polls:', scheduledMessages.map(m => m.id));
      
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

    console.log('Found poll data:', JSON.stringify(pollData, null, 2));

    const options = (pollData.pollOptions || '').split('\n').filter(Boolean);
    console.log(`Poll options:`, options);

    if (messageTs && !activePollMessages.has(messageTs)) {
      activePollMessages.set(messageTs, pollData);
      console.log(`Stored poll data in activePollMessages for ${messageTs}`);
    }

    if (!pollVotes[msgId]) {
      pollVotes[msgId] = {};
      console.log(`Created new vote tracking for msgId: ${msgId}`);
    }

    for (let i = 0; i < options.length; i++) {
      if (!pollVotes[msgId][i]) {
        pollVotes[msgId][i] = new Set();
        console.log(`Created vote set for option ${i}`);
      }
    }

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

    if (!pollVotes[msgId][optionIndex]) {
      pollVotes[msgId][optionIndex] = new Set();
      console.log(`Created missing vote set for option ${optionIndex}`);
    }

    console.log(`Vote tracking state for ${msgId}:`, Object.keys(pollVotes[msgId]));

    let userVoteChanged = false;

    // Handle voting logic based on poll type
    if (pollData.pollType === 'single') {
      // Single choice: remove from all other options first
      Object.keys(pollVotes[msgId]).forEach(idx => {
        if (parseInt(idx) !== optionIndex && pollVotes[msgId][idx].has(user)) {
          pollVotes[msgId][idx].delete(user);
          userVoteChanged = true;
        }
      });
      
      // Toggle vote for this option
      if (pollVotes[msgId][optionIndex].has(user)) {
        pollVotes[msgId][optionIndex].delete(user);
        console.log(`Removed vote from option ${optionIndex} (single choice)`);
        userVoteChanged = true;
      } else {
        pollVotes[msgId][optionIndex].add(user);
        console.log(`Added vote to option ${optionIndex} (single choice)`);
        userVoteChanged = true;
      }
    } else {
      // Multiple choice: toggle vote for this option only
      if (pollVotes[msgId][optionIndex].has(user)) {
        pollVotes[msgId][optionIndex].delete(user);
        console.log(`Removed vote from option ${optionIndex} (multiple choice)`);
        userVoteChanged = true;
      } else {
        pollVotes[msgId][optionIndex].add(user);
        console.log(`Added vote to option ${optionIndex} (multiple choice)`);
        userVoteChanged = true;
      }
    }

    // Update the poll message with new vote counts
    if (userVoteChanged && messageTs && channel) {
      console.log('About to update poll message with vote data:', JSON.stringify(pollVotes[msgId], null, 2));
      await updatePollMessage(client, channel, messageTs, pollData, pollVotes[msgId]);
    }

    // Send confirmation to user
    try {
      const voteStatus = pollVotes[msgId][optionIndex].has(user) ? 'Vote added' : 'Vote removed';
      const optionText = options[optionIndex];
        
      await client.chat.postEphemeral({
        channel: channel || user,
        user: user,
        text: `${voteStatus} for "${optionText}"!`
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
      res.end('PM Squad Bot Enhanced is running!');
    });

    const PORT = process.env.PORT || 3000;
    keepAliveServer.listen(PORT, () => {
      console.log(`Keep-alive server running on port ${PORT}`);
    });

    // Reschedule existing jobs
    scheduledMessages.forEach(msg => scheduleJob(msg));

    await app.start();
    
    console.log('PM Squad Bot "Cat Scratch" Enhanced Version is running!');
    console.log(`Loaded ${scheduledMessages.length} scheduled messages`);
    console.log(`Active jobs: ${jobs.size}`);
    console.log(`Current EST time: ${currentTimeInEST()}`);
    console.log(`Current EST date: ${todayInEST()}`);
    console.log(`User data entries: ${Object.keys(userData).length}`);

    if (scheduledMessages.length > 0) {
      console.log('Scheduled Messages:');
      scheduledMessages.forEach(msg => {
        const nextRun = msg.repeat === 'none' ?
          `${msg.date} at ${msg.time}` :
          `${msg.repeat} at ${msg.time}`;
        console.log(`  - ${msg.type}: ${nextRun} -> #${msg.channel}`);
      });
    }

    console.log('Available commands:');
    console.log('  /cat - Main menu');
    console.log('  /capacity - Direct capacity check');
    console.log('  /help - Direct help button');
    console.log('  /poll - Direct poll creation');
    console.log('  /manage - Message management');
    console.log('All systems ready!');
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
