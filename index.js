/**
 * PM Squad Bot - Cat Scratch (FIXED VERSION)
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
const formData = new Map(); // Store form data for navigation
const activePollMessages = new Map(); // Store sent poll messages by their Slack timestamp

function saveMessages() {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduledMessages, null, 2));
  } catch (e) {
    console.error('❌ Save failed:', e);
  }
}

function loadMessages() {
  if (fs.existsSync(SCHEDULE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE));
      // Filter out completed one-time messages
      scheduledMessages = data.filter(msg => {
        if (msg.repeat !== 'none') return true;
        return !isDateTimeInPast(msg.date, msg.time);
      });
      saveMessages(); // Clean up the file
    } catch (e) {
      console.error('❌ Load failed:', e);
      scheduledMessages = [];
    }
  }
}

loadMessages();

// ================================
// UTILITIES
// ================================

const generateId = () => `msg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

const cat = () => Math.random() < 0.35 ? ` ${['₍^. .^₎⟆', 'ᓚ₍ ^. .^₎', 'ฅ^•ﻌ•^ฅ'][Math.floor(Math.random() * 4)]}` : '';

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
    // Get current date and time in EST
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

    console.log(`🕐 Schedule Check:`);
    console.log(`   Requested: ${dateStr} at ${timeStr}`);
    console.log(`   Current EST: ${currentEST} at ${currentTimeEST}`);

    // If different dates, compare dates
    if (dateStr !== currentEST) {
      const isPast = dateStr < currentEST;
      console.log(`   Different dates - Is past: ${isPast}`);
      return isPast;
    }

    // Same date, compare times (allow scheduling for current minute)
    const isPast = timeStr < currentTimeEST;

    console.log(`   Same date - Time comparison: ${timeStr} vs ${currentTimeEST} - Is past: ${isPast}`);
    return isPast;

  } catch (error) {
    console.error('❌ Timezone calculation error:', error);
    // Very conservative fallback - allow scheduling
    return false;
  }
}

// Improved getFormValue: includes initial_conversation(s) fallbacks
function getFormValue(values, blockId, actionId, type = 'value') {
  const block = values?.[blockId]?.[actionId];

  console.log(`Getting form value - Block: ${blockId}, Action: ${actionId}, Type: ${type}`);
  console.log(`Block data:`, JSON.stringify(block, null, 2));

  if (type === 'selected') return block?.selected_option?.value;

  if (type === 'conversation') {
    // prefer selected_conversation, but fall back to initial_conversation and other shapes
    const channelId = block?.selected_conversation ||
                      block?.initial_conversation ||
                      block?.selected_channel ||
                      block?.value;
    console.log(`Channel ID extracted: ${channelId}`);
    return channelId;
  }

  if (type === 'conversations') {
    // multi_conversations_select returns selected_conversations or initial_conversations
    return block?.selected_conversations || block?.initial_conversations || [];
  }
  if (type === 'time') return block?.selected_time;
  if (type === 'date') return block?.selected_date;

  const value = block?.value?.trim();
  console.log(`Text value extracted: ${value}`);
  return value;
}

function getInitialTextValue(page, data) {
  console.log(`📝 Getting initial text value for page: ${page}, data.text: "${data.text}", data.type: "${data.type}"`);

  // If data.text is explicitly set (even if empty string), use it
  if (data.text !== undefined) {
    console.log(`📝 Using existing text: "${data.text}"`);
    return data.text;
  }

  // Otherwise use template defaults for new messages only
  if (page === 'capacity') {
    console.log(`📝 Using capacity template`);
    return templates.capacity;
  }
  if (page === 'help') {
    console.log(`📝 Using help template`);
    return templates.help;
  }

  console.log(`📝 Using empty string for ${page}`);
  return ''; // Custom and poll return empty string
}

// Check if user has modified the template text
function hasUserModifiedTemplate(type, text) {
  if (!text) return false;

  const template = type === 'capacity' ? templates.capacity :
    type === 'help' ? templates.help : '';

  return template && text !== template;
}

// ================================
// TEMPLATES
// ================================

const templates = {
  capacity: "**Daily Bandwidth Check** ₍^. .^₎⟆\nHow's everyone's capacity looking today?\n\nUse the reactions below to share your current workload:\n🟢 Light schedule - Ready for new work\n🟡 Manageable schedule\n🟠 Schedule is full, no new work\n🔴 Overloaded - Need help now",
  help: "**Need Backup?** ₍^. .^₎⟆\nIf you're stuck or need assistance, click the button below to alert the team."
};

// ================================
// PREVIEW GENERATOR
// ================================

function generatePreview(data) {
  let previewText = '';

  // Only show title if it exists (polls and custom can have titles)
  if (data.title && data.type !== 'capacity' && data.type !== 'help') {
    previewText += `*${data.title}*\n`;
  }

  if (data.type === 'capacity') {
    previewText += data.text || templates.capacity;
  } else if (data.type === 'poll') {
    previewText += `*${data.title || 'Poll'}*\n`;
    if (data.text) previewText += `${data.text}\n`;

    if (data.pollType === 'open') {
      previewText += '\n_Open discussion - responses in thread_';
    } else if (data.pollOptions) {
      const options = data.pollOptions.split('\n').filter(o => o.trim());
      previewText += '\n' + options.map((opt, i) => `${i + 1}. ${opt.trim()}`).join('\n');

      // Show poll settings in preview
      if (data.pollSettings?.length > 0) {
        previewText += `\n\n_Settings: ${data.pollSettings.join(', ')}_`;
      }

      // Show voting type
      const voteType = data.pollType === 'single' ? 'Single choice' : 'Multiple choice';
      previewText += `\n_Type: ${voteType}_`;
    }
  } else if (data.type === 'help') {
    previewText += data.text || templates.help;
    previewText += '\n\n🆘 Request Backup (button)';
  } else {
    // Custom message
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
// MODAL CREATION - FIXED VERSION
// ================================

function createModal(page, data = {}) {
  const base = {
    type: 'modal',
    callback_id: `scheduler_${page}`,
    title: { type: 'plain_text', text: 'PM Squad Manager' },
    close: { type: 'plain_text', text: 'Cancel' }
  };

  console.log(`🏗️ Creating modal for page: ${page}`);
  console.log(`📋 Data being used:`, JSON.stringify(data, null, 2));

  // MENU PAGE
  if (page === 'menu') {
    return {
      ...base,
      title: { type: 'plain_text', text: 'Cat Scratch Menu' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Choose a message type:*' }},
        { type: 'divider' },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Capacity Check' }, action_id: 'nav_capacity' },
            { type: 'button', text: { type: 'plain_text', text: 'Poll' }, action_id: 'nav_poll' }
          ]
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Help Button' }, action_id: 'nav_help' },
            { type: 'button', text: { type: 'plain_text', text: 'Custom Message' }, action_id: 'nav_custom' }
          ]
        },
        { type: 'divider' },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'View Scheduled' }, action_id: 'nav_scheduled' }
          ]
        }
      ]
    };
  }

  // SCHEDULED PAGE
  if (page === 'scheduled') {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `*Scheduled Messages* (${scheduledMessages.length} total)` }},
      { type: 'divider' }
    ];

    if (scheduledMessages.length === 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_No scheduled messages yet_${cat()}` }});
    } else {
      scheduledMessages.forEach(msg => {
        const nextRun = msg.repeat === 'none' ? `${msg.date} at ${formatTimeDisplay(msg.time)}` : `${msg.repeat} at ${formatTimeDisplay(msg.time)}`;
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${msg.title || msg.type}*\n📅 ${nextRun}\n📍 <#${msg.channel}>\n_${(msg.text || '').substring(0, 100)}${(msg.text || '').length > 100 ? '...' : ''}_`
          },
          accessory: {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: 'Delete' },
            action_id: `delete_message_${msg.id}`,
            value: msg.id,
            confirm: {
              title: { type: 'plain_text', text: 'Delete Message' },
              text: { type: 'mrkdwn', text: `Are you sure you want to delete "*${msg.title || msg.type}*"?` },
              confirm: { type: 'plain_text', text: 'Delete' },
              deny: { type: 'plain_text', text: 'Cancel' }
            }
          }
        });
      });
    }

    blocks.push(
      { type: 'divider' },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '← Back' }, action_id: 'nav_menu' }]}
    );

    return { ...base, blocks };
  }

  // PREVIEW PAGE
  if (page === 'preview') {
    const previewBlock = generatePreview(data);

    return {
      ...base,
      title: { type: 'plain_text', text: `${data.type ? data.type.charAt(0).toUpperCase() + data.type.slice(1) : 'Message'} Preview` },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Step 2: Preview Your Message*' }},
        previewBlock,
        { type: 'divider' },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '← Back to Edit' }, action_id: `nav_${data.type || 'custom'}` },
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Continue to Send/Schedule' }, action_id: 'nav_schedule' }
          ]
        }
      ]
    };
  }

  // SCHEDULE PAGE - FIXED VERSION
  if (page === 'schedule') {
    const scheduleBlocks = [
      { type: 'section', text: { type: 'mrkdwn', text: '*Step 3: Send or Schedule Message*' }},
      { type: 'divider' },

      // Channel Selection Section
      { type: 'section', text: { type: 'mrkdwn', text: '*Where to send:*' }},
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

    // Add alert channels for help messages
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

    // Timing Section
    scheduleBlocks.push(
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*When to send this message:*' }},
      {
        type: 'actions',
        block_id: 'send_timing_block',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🐈‍⬛ Post Now' },
            style: data.scheduleType === 'now' ? 'primary' : undefined,
            action_id: 'timing_now',
            value: 'now'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🧶 Schedule for Later' },
            style: data.scheduleType === 'schedule' || !data.scheduleType ? 'primary' : undefined,
            action_id: 'timing_schedule',
            value: 'schedule'
          }
        ]
      }
    );

    // Only show date/time/repeat inputs if "schedule for later" is selected
    if (data.scheduleType === 'schedule' || !data.scheduleType) {
      scheduleBlocks.push(
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*Schedule Details:*' }},
        
        // FIXED: Use separate input blocks for date/time pickers
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

    // Final action buttons
    scheduleBlocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '← Back to Preview' }, action_id: 'nav_preview' },
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Post' },
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

  // FORM PAGES (capacity, poll, help, custom)
  const commonBlocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Step 1: Create Your ${page.charAt(0).toUpperCase() + page.slice(1)} Message*` }},
    { type: 'divider' }
  ];

  if ((page === 'capacity' || page === 'help') && !data.userModifiedText) {
    const templateInfo = page === 'capacity' ?
      '_Using default capacity check template. Feel free to customize the message text below._' :
      '_Using default help button template. Feel free to customize the message text below._';

    commonBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${templateInfo}`
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
        placeholder: { type: 'plain_text', text: 'Message title...' }
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
        placeholder: { type: 'plain_text', text: 'Message content...' }
      }
    }
  );

  // POLL specific blocks
  if (page === 'poll') {
    console.log('🎯 Adding POLL-specific blocks');
    try {
      commonBlocks.push(
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*Poll Configuration*' }}
      );

      const radioOptions = [
        {
          text: { type: 'plain_text', text: 'Single Choice', emoji: true },
          description: { type: 'plain_text', text: 'One selection per person' },
          value: 'single'
        },
        {
          text: { type: 'plain_text', text: 'Multiple Choice', emoji: true },
          description: { type: 'plain_text', text: 'Multiple selections allowed' },
          value: 'multiple'
        },
        {
          text: { type: 'plain_text', text: 'Open Discussion', emoji: true },
          description: { type: 'plain_text', text: 'Thread-based responses' },
          value: 'open'
        }
      ];

      const selectedType = data.pollType || 'single';
      let initialOption;
      if (selectedType === 'multiple') {
        initialOption = radioOptions[1];
      } else if (selectedType === 'open') {
        initialOption = radioOptions[2];
      } else {
        initialOption = radioOptions[0];
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
          { type: 'section', text: { type: 'mrkdwn', text: '*Poll Options*' }}
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
            text: { type: 'plain_text', text: 'Add Option', emoji: true },
            action_id: 'add_poll_option',
            value: 'add'
          });
        }

        if (options.length > 2) {
          actionElements.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Remove Last Option', emoji: true },
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
            text: "_Open discussion polls don't need predefined options. People will respond in the message thread."
          }
        });
      }

    } catch (error) {
      console.error('❌ Error creating poll form:', error);
      commonBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: 'Poll form error - using fallback. Please try again.' }
      });
    }
  }

  const actionBlocks = [
    { type: 'divider' }
  ];

  // Add reset to template option for capacity and help if user has modified
  if ((page === 'capacity' || page === 'help') && data.userModifiedText) {
    actionBlocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reset to Template' },
          action_id: `reset_template_${page}`,
          style: 'danger'
        }
      ]
    });
  }

  actionBlocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: '← Back' }, action_id: 'nav_menu' },
      { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Preview Message' }, action_id: 'nav_preview' }
    ]
  });

  const finalModal = {
    ...base,
    title: { type: 'plain_text', text: `${page.charAt(0).toUpperCase() + page.slice(1)} Message` },
    submit: { type: 'plain_text', text: 'Preview Message' },
    blocks: [...commonBlocks, ...actionBlocks]
  };

  console.log(`✅ Created ${page} modal with ${finalModal.blocks.length} blocks`);
  return finalModal;
}

// ================================
// MESSAGE SENDING
// ================================

// ================================
// MESSAGE SENDING
// ================================

// Function to update poll message with current vote counts
async function updatePollMessage(client, channel, messageTs, pollData, votes) {
  try {
    console.log(`🔄 Updating poll message in ${channel} at ${messageTs}`);
    
    const options = (pollData.pollOptions || '').split('\n').filter(Boolean);
    const showCounts = pollData.pollSettings?.includes('show_counts') || false;
    const anonymous = pollData.pollSettings?.includes('anonymous') || false;
    
    // Build updated blocks
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
        
        // Add vote count to button text if enabled
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

      // Add button rows (max 5 buttons per row)
      for (let i = 0; i < buttonElements.length; i += 5) {
        blocks.push({
          type: 'actions',
          block_id: `poll_${pollData.id}_${i}`,
          elements: buttonElements.slice(i, i + 5)
        });
      }
      
      // Add vote summary section if showing counts and not anonymous
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

    // Context with voting instructions
    let contextText = pollData.pollType === 'single' ? '_Click to vote. Click again to unvote._' :
      pollData.pollType === 'multiple' ? '_Click to vote (multiple choices). Click again to unvote._' :
      '_Open-ended poll. Use thread replies to respond._';
      
    // Add total vote count to context if showing counts
    if (showCounts && pollData.pollType !== 'open') {
      const totalVotes = Object.values(votes).reduce((sum, voteSet) => sum + voteSet.size, 0);
      contextText += ` • Total votes: ${totalVotes}`;
    }

    blocks.push({ 
      type: 'context', 
      elements: [{ type: 'mrkdwn', text: contextText }]
    });

    // Update the message
    await client.chat.update({
      channel: channel,
      ts: messageTs,
      text: pollData.title || 'Poll',
      blocks: blocks
    });
    
    console.log(`✅ Poll message updated successfully`);
    
  } catch (error) {
    console.error('❌ Failed to update poll message:', error);
  }
}

async function sendMessage(msg) {
  try {
    console.log(`🐈‍⬛ Attempting to send ${msg.type} message to channel: ${msg.channel}`);
    console.log('📋 Full message data:', JSON.stringify(msg, null, 2));

    // Validate channel exists
    if (!msg.channel) {
      console.error('❌ No channel specified in message data');
      return false;
    }

    // Test channel access first
    try {
      console.log(`🔍 Testing access to channel: ${msg.channel}`);
      const channelInfo = await app.client.conversations.info({ channel: msg.channel });
      console.log(`✅ Channel accessible: #${channelInfo.channel.name} (${channelInfo.channel.id})`);
    } catch (channelError) {
      console.error(`❌ Channel access failed for ${msg.channel}:`, channelError?.data || channelError?.message || channelError);
      return false;
    }

    if (msg.type === 'capacity') {
      console.log('📤 Sending capacity check message...');
      const messageText = (msg.title ? `*${msg.title}*\n` : '') + (msg.text || templates.capacity) + cat();
      console.log('Message text to send:', messageText);

      const result = await app.client.chat.postMessage({
        channel: msg.channel,
        text: messageText
      });

      console.log('📬 Capacity message result:', result);

      // Add reactions if message posted successfully
      if (result.ok && result.ts) {
        console.log('➕ Adding capacity check reactions...');
        const reactions = ['green_circle', 'yellow_circle', 'orange_circle', 'red_circle'];
        for (const reaction of reactions) {
          try {
            await new Promise(resolve => setTimeout(resolve, 100));
            await app.client.reactions.add({
              channel: msg.channel,
              timestamp: result.ts,
              name: reaction
            });
            console.log(`✅ Added reaction: ${reaction}`);
          } catch (e) {
            console.error(`❌ Reaction failed for ${reaction}:`, e?.data?.error || e?.message);
          }
        }
      }
    } else if (msg.type === 'poll') {
      console.log('📤 Sending enhanced poll message...');
      const options = (msg.pollOptions || '').split('\n').map(s => s.trim()).filter(Boolean);
      console.log('Poll options:', options);

      // Initialize vote tracking
      if (!pollVotes[msg.id]) {
        pollVotes[msg.id] = {};
        // Initialize empty vote sets for all options
        for (let i = 0; i < options.length; i++) {
          pollVotes[msg.id][i] = new Set();
        }
      }

      let blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*${msg.title || 'Poll'}*${cat()}\n${msg.text || ''}` }}
      ];

      if (msg.pollType !== 'open' && options.length > 0) {
        const buttonElements = options.map((option, idx) => ({
          type: 'button',
          text: { type: 'plain_text', text: option.slice(0, 70) },
          action_id: `poll_vote_${msg.id}_${idx}`,
          value: `${idx}`
        }));

        for (let i = 0; i < buttonElements.length; i += 5) {
          blocks.push({
            type: 'actions',
            block_id: `poll_${msg.id}_${i}`,
            elements: buttonElements.slice(i, i + 5)
          });
        }
      }

      let contextText = msg.pollType === 'single' ? '_Click to vote. Click again to unvote._' :
        msg.pollType === 'multiple' ? '_Click to vote (multiple choices). Click again to unvote._' :
        '_Open-ended poll. Use thread replies to respond._';

      // Add settings info to context
      if (msg.pollSettings?.includes('show_counts')) {
        contextText += ' • Vote counts: ON';
      }
      if (msg.pollSettings?.includes('anonymous')) {
        contextText += ' • Anonymous voting: ON';
      }

      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextText }]});

      console.log('Enhanced poll blocks:', JSON.stringify(blocks, null, 2));

      const result = await app.client.chat.postMessage({
        channel: msg.channel,
        text: msg.title || 'Poll',
        blocks
      });

      // Store poll metadata for later updates
      if (result.ok && result.ts) {
        activePollMessages.set(result.ts, msg);
        console.log(`📋 Stored poll metadata for message ${result.ts}`);
      }

      console.log('📬 Enhanced poll message result:', result);

    } else if (msg.type === 'help') {
      console.log('📤 Sending help button message...');
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
              text: { type: 'plain_text', text: '🆘 Request Backup' },
              action_id: `help_click_${msg.id}`,
              value: JSON.stringify({
                msgId: msg.id,
                alertChannels: msg.alertChannels || []
              })
            }
          ]
        }
      ];

      console.log('Help button blocks:', JSON.stringify(blocks, null, 2));

      const result = await app.client.chat.postMessage({
        channel: msg.channel,
        text: msg.text || 'Help button',
        blocks
      });

      console.log('📬 Help message result:', result);

    } else {
      // Custom message
      console.log('📤 Sending custom message...');
      const messageText = (msg.title ? `*${msg.title}*\n` : '') + (msg.text || '(no content)') + cat();
      console.log('Custom message text:', messageText);

      const result = await app.client.chat.postMessage({
        channel: msg.channel,
        text: messageText
      });

      console.log('📬 Custom message result:', result);
    }

    console.log(`✅ ${msg.type} message sent successfully to channel ${msg.channel}`);
    return true;
  } catch (e) {
    console.error('❌ Send failed with error:', e);
    console.error('Error details:', e?.data || e?.message);
    console.error('Error stack:', e?.stack);
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
    // One-time message
    const [y, mon, d] = msg.date.split('-');
    cronExpr = `${mm} ${hh} ${d} ${mon} *`;
  }

  console.log(`🐈‍⬛ Scheduling job for ${msg.type} message: ${cronExpr}`);
  console.log(`📋 Message details:`, JSON.stringify({
    id: msg.id,
    type: msg.type,
    channel: msg.channel,
    title: msg.title,
    date: msg.date,
    time: msg.time,
    repeat: msg.repeat
  }, null, 2));

  const job = cron.schedule(cronExpr, async () => {
    console.log(`🚀 EXECUTING scheduled ${msg.type} message at ${new Date().toISOString()}`);
    console.log(`📋 Message being sent:`, JSON.stringify(msg, null, 2));

    const success = await sendMessage(msg);

    if (success) {
      console.log(`✅ Scheduled message executed successfully`);
    } else {
      console.error(`❌ Scheduled message execution failed`);
    }

    if (msg.repeat === 'none') {
      // Remove one-time message after sending
      scheduledMessages = scheduledMessages.filter(m => m.id !== msg.id);
      saveMessages();
      try {
        job.destroy();
      } catch (_) {}
      jobs.delete(msg.id);
      console.log(`🗑️ Removed completed one-time message ${msg.id}`);
    }
  }, {
    timezone: 'America/New_York'
  });

  jobs.set(msg.id, job);
  console.log(`📅 Job scheduled successfully for message ${msg.id}`);
}

// Re-register jobs on startup
scheduledMessages.forEach(msg => {
  if (msg.repeat !== 'none' || !isDateTimeInPast(msg.date, msg.time)) {
    scheduleJob(msg);
  }
});

// ================================
// HANDLERS
// ================================

// Slash command - Entry point
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

// NAVIGATION HANDLERS
['nav_menu', 'nav_scheduled', 'nav_preview', 'nav_schedule'].forEach(action => {
  app.action(action, async ({ ack, body, client }) => {
    await ack();
    try {
      const page = action.replace('nav_', '');
      const userId = body.user.id;

      console.log(`🚀 Navigation to: ${page} for user ${userId}`);

      let data = {};

      if (page !== 'menu' && page !== 'scheduled') {
        // Get stored form data for this user
        data = formData.get(userId) || {};

        // If navigating to preview or schedule, extract current form data
        if ((page === 'preview' || page === 'schedule') && body.view?.state?.values) {
          const values = body.view.state.values;
          console.log('📋 Extracting form values for navigation...');

          // Extract common form data
          data = {
            ...data,
            ...(data.type !== 'capacity' && data.type !== 'help' && {
              title: getFormValue(values, 'title_block', 'title_input') || data.title
            }),
            text: getFormValue(values, 'text_block', 'text_input') || data.text,
          };

          // Mark that user has potentially modified the text
          if (data.text && data.type) {
            data.userModifiedText = hasUserModifiedTemplate(data.type, data.text);
            console.log(`📝 User modified ${data.type} template: ${data.userModifiedText}`);
          }

          // Extract schedule-specific data when going to/from schedule page
          if (page === 'schedule' || page === 'preview') {
            data.channel = getFormValue(values, 'channel_block', 'channel_select', 'conversation') || data.channel;
            // FIXED: Use separate block IDs
            data.date = getFormValue(values, 'date_block', 'date_picker', 'date') || data.date;
            data.time = getFormValue(values, 'time_block', 'time_picker', 'time') || data.time;
            data.repeat = getFormValue(values, 'repeat_block', 'repeat_select', 'selected') || data.repeat || 'none';
          }

          // Handle type-specific data
          if (data.type === 'poll') {
            // Extract poll type from radio buttons
            const pollTypeBlock = values?.poll_type_section?.poll_type_radio;
            data.pollType = pollTypeBlock?.selected_option?.value || data.pollType || 'single';

            // Extract poll settings from checkboxes
            const settingsBlock = values?.poll_settings_section?.poll_settings_checkboxes;
            data.pollSettings = settingsBlock?.selected_options?.map(opt => opt.value) || data.pollSettings || [];

            // Extract individual poll options
            if (data.pollType !== 'open') {
              let extractedOptions = [];
              let index = 0;
              while (values[`option_${index}_block`]) {
                const optionValue = values[`option_${index}_block`][`option_${index}_input`]?.value?.trim();
                if (optionValue) {
                  extractedOptions.push(optionValue);
                }
                index++;
              }
              if (extractedOptions.length > 0) {
                data.pollOptions = extractedOptions.join('\n');
              }
            }

            console.log('Enhanced poll data extracted:', JSON.stringify({
              pollType: data.pollType,
              pollSettings: data.pollSettings,
              pollOptions: data.pollOptions
            }, null, 2));
          }

          if (data.type === 'help') {
            const extractedAlertChannels = getFormValue(values, 'alert_channels_block', 'alert_channels_select', 'conversations');
            data.alertChannels = extractedAlertChannels || data.alertChannels || [];
          }

          console.log('📋 Extracted navigation data:', JSON.stringify(data, null, 2));
        }

        // Set default schedule type if not set
        if (!data.scheduleType) {
          data.scheduleType = 'schedule'; // Default to schedule for later
          console.log(`📅 Set default schedule type: ${data.scheduleType}`);
        }

        // Store user data for navigation
        formData.set(userId, data);
      }

      await client.views.update({
        view_id: body.view.id,
        view: createModal(page, data)
      });

      console.log(`✅ Successfully navigated to ${page}`);
    } catch (error) {
      console.error(`❌ Failed to navigate to ${action}:`, error);
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

      console.log(`🔄 Navigating to ${messageType} form for user ${userId}`);

      // Get existing data or create fresh data
      let data = formData.get(userId) || {};

      console.log(`📋 Existing data:`, JSON.stringify(data, null, 2));

      // If this is a completely new message type selection (from menu)
      // OR if we're switching to a different type, reset appropriately
      if (!data.type || data.type !== messageType) {
        console.log(`🆕 New ${messageType} message or type change from ${data.type} to ${messageType}`);

        // Clear previous data when switching types to prevent template mixing
        if (messageType === 'capacity') {
          data = {
            type: 'capacity',
            text: templates.capacity,
            userModifiedText: false,
            scheduleType: 'schedule'
          };
        } else if (messageType === 'help') {
          data = {
            type: 'help',
            text: templates.help,
            userModifiedText: false,
            alertChannels: [],
            scheduleType: 'schedule'
          };
        } else if (messageType === 'poll') {
          data = {
            type: 'poll',
            text: '',
            title: '',
            pollType: 'single',
            pollOptions: 'Option 1\nOption 2',
            pollSettings: [],
            scheduleType: 'schedule'
          };
        } else if (messageType === 'custom') {
          data = {
            type: 'custom',
            text: '',
            title: '',
            scheduleType: 'schedule'
          };
        }
      } else {
        console.log(`🔄 Returning to existing ${messageType} message`);
        // Just ensure type is set correctly, preserve all other data
        data.type = messageType;

        // Ensure we have the right template if text was cleared somehow
        if (!data.text && (messageType === 'capacity' || messageType === 'help')) {
          data.text = messageType === 'capacity' ? templates.capacity : templates.help;
          data.userModifiedText = false;
        }

        // Ensure poll-specific fields exist
        if (messageType === 'poll') {
          if (!data.pollType) data.pollType = 'single';
          if (!data.pollOptions) data.pollOptions = 'Option 1\nOption 2';
          if (!data.pollSettings) data.pollSettings = [];
        }

        // Ensure help-specific fields exist
        if (messageType === 'help' && !data.alertChannels) {
          data.alertChannels = [];
        }
      }

      // Reset schedule type to default for consistency
      if (!data.scheduleType) {
        data.scheduleType = 'schedule';
        console.log(`📅 Set default schedule type for ${messageType}: ${data.scheduleType}`);
      }

      console.log(`💾 Storing ${messageType} data:`, JSON.stringify(data, null, 2));
      formData.set(userId, data);

      console.log(`🚀 Creating modal for ${messageType}`);
      const modal = createModal(messageType, data);

      await client.views.update({
        view_id: body.view.id,
        view: modal
      });

      console.log(`✅ Successfully navigated to ${messageType} form`);
    } catch (error) {
      console.error(`❌ Failed to navigate to ${action}:`, error);
      console.error('Error details:', error.message);
      console.error('Error stack:', error.stack);
    }
  });
});

// ================================
// TEMPLATE RESET HANDLERS
// ================================

['reset_template_capacity', 'reset_template_help'].forEach(action => {
  app.action(action, async ({ ack, body, client }) => {
    await ack();
    try {
      const type = action.replace('reset_template_', '');
      const userId = body.user.id;

      let data = formData.get(userId) || {};

      // Reset to template
      if (type === 'capacity') {
        data.text = templates.capacity;
      } else if (type === 'help') {
        data.text = templates.help;
      }

      // Mark as no longer user-modified
      data.userModifiedText = false;

      console.log(`🔄 Reset ${type} message to template`);
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

// ================================
// SCHEDULE PAGE SPECIFIC HANDLERS - FIXED
// ================================

app.action('timing_now', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};
    data.scheduleType = 'now';
    formData.set(userId, data);

    console.log('📤 User selected "Post Now" - schedule type set to:', data.scheduleType);

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

    console.log('⏰ User selected "Schedule for Later" - schedule type set to:', data.scheduleType);

    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (error) {
    console.error('Timing schedule error:', error);
  }
});

// Channel selection handler
app.action('channel_select', async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const selectedChannel = body.actions[0].selected_conversation || body.actions[0].initial_conversation;

  console.log(`📍 CHANNEL SELECTED: User ${userId} selected channel ${selectedChannel}`);
  console.log(`📋 Full action data:`, JSON.stringify(body.actions[0], null, 2));

  // Update stored form data immediately
  let data = formData.get(userId) || {};
  data.channel = selectedChannel;
  formData.set(userId, data);

  console.log(`💾 UPDATED USER DATA:`, JSON.stringify(data, null, 2));

  // Test channel access immediately to provide feedback
  try {
    const channelInfo = await client.conversations.info({ channel: selectedChannel });
    console.log(`✅ Channel verified: #${channelInfo.channel.name} (${channelInfo.channel.id})`);
  } catch (error) {
    console.error(`❌ Channel verification failed for ${selectedChannel}:`, error?.data?.error || error?.message);
    // Surface helpful ephemeral message to the user
    try {
      await client.chat.postEphemeral({
        channel: selectedChannel || body.user.id,
        user: userId,
        text: `I couldn't verify access to the selected channel. If it's a private channel, please invite me first (\`/invite @your-bot-name\`).`
      });
    } catch (e) {
      console.log('Note: Could not send ephemeral channel verification message (maybe channel invalid).');
    }
  }
});

// Date picker handler - FIXED
app.action('date_picker', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedDate = body.actions[0].selected_date;

  let data = formData.get(userId) || {};
  data.date = selectedDate;
  data.scheduleType = 'schedule'; // Selecting date implies scheduling
  formData.set(userId, data);

  console.log(`📅 Date selected: ${selectedDate} for user ${userId}`);

  // Optional UX: refresh modal so user sees selection immediately
  try {
    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (e) {
    console.log('Could not refresh modal after date selection (safe to ignore).');
  }
});

// Time picker handler - FIXED
app.action('time_picker', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedTime = body.actions[0].selected_time;

  let data = formData.get(userId) || {};
  data.time = selectedTime;
  data.scheduleType = 'schedule'; // Selecting time implies scheduling
  formData.set(userId, data);

  console.log(`⏰ Time selected: ${selectedTime} for user ${userId}`);

  // Optional UX: refresh modal so user sees selection immediately
  try {
    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (e) {
    console.log('Could not refresh modal after time selection (safe to ignore).');
  }
});

// Repeat selector handler
app.action('repeat_select', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedRepeat = body.actions[0].selected_option.value;

  let data = formData.get(userId) || {};
  data.repeat = selectedRepeat;
  formData.set(userId, data);

  console.log(`🔄 Repeat selected: ${selectedRepeat} for user ${userId}`);

  // Optional: refresh modal to reflect repeat selection
  try {
    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (e) {
    console.log('Could not refresh modal after repeat selection (safe to ignore).');
  }
});

// Alert channels handler - FIXED
app.action('alert_channels_select', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const selectedChannels = body.actions[0].selected_conversations || body.actions[0].initial_conversations || [];

  let data = formData.get(userId) || {};
  data.alertChannels = selectedChannels;
  formData.set(userId, data);

  console.log(`🚨 Alert channels selected: ${selectedChannels.length} channels for user ${userId}`);
  console.log('🚨 Selected channels:', selectedChannels);

  // Optional: refresh modal so user sees selection immediately
  try {
    await client.views.update({
      view_id: body.view.id,
      view: createModal('schedule', data)
    });
  } catch (e) {
    console.log('Could not refresh modal after alert channels selection (safe to ignore).');
  }
});

// ================================
// POLL FORM INTERACTIVE HANDLERS
// ================================

// Poll type radio button handler
app.action('poll_type_radio', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const selectedType = body.actions[0].selected_option.value;

    let data = formData.get(userId) || {};
    data.pollType = selectedType;

    // Clear options if switching to open discussion
    if (selectedType === 'open') {
      data.pollOptions = '';
    }

    formData.set(userId, data);
    console.log(`📊 User changed poll type to: ${selectedType}`);

    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Poll type radio error:', error);
  }
});

// Add poll option handler
app.action('add_poll_option', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};

    // Extract current form data first
    const values = body.view.state.values;

    // Get existing options
    let options = [];
    let index = 0;
    while (values[`option_${index}_block`]) {
      const optionValue = values[`option_${index}_block`][`option_${index}_input`]?.value?.trim();
      if (optionValue) {
        options.push(optionValue);
      }
      index++;
    }

    // Only add a new option if the last option has text (avoid blanks)
    if (!options[options.length - 1]) {
      options[options.length - 1] = `Option ${options.length}`;
    } else {
      options.push(`Option ${options.length + 1}`);
    }

    data.pollOptions = options.join('\n');

    formData.set(userId, data);
    console.log(`➕ Added poll option, now ${options.length} options`);

    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Add poll option error:', error);
  }
});

// Remove poll option handler
app.action('remove_poll_option', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};

    // Extract current form data first
    const values = body.view.state.values;

    // Get existing options
    let options = [];
    let index = 0;
    while (values[`option_${index}_block`]) {
      const optionValue = values[`option_${index}_block`][`option_${index}_input`]?.value?.trim();
      if (optionValue) {
        options.push(optionValue);
      }
      index++;
    }

    // Remove last option (but keep at least 2)
    if (options.length > 2) {
      options.pop();
    }

    data.pollOptions = options.join('\n');

    formData.set(userId, data);
    console.log(`➖ Removed poll option, now ${options.length} options`);

    await client.views.update({
      view_id: body.view.id,
      view: createModal('poll', data)
    });
  } catch (error) {
    console.error('Remove poll option error:', error);
  }
});

// Poll settings checkboxes handler
app.action('poll_settings_checkboxes', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    let data = formData.get(userId) || {};

    const selectedOptions = body.actions[0].selected_options || [];
    data.pollSettings = selectedOptions.map(opt => opt.value);

    formData.set(userId, data);
    console.log(`⚙️ Updated poll settings:`, data.pollSettings);
  } catch (error) {
    console.error('Poll settings error:', error);
  }
});

// ================================
// MODAL SUBMISSION HANDLER - FIXED WITH PROPER VALIDATION
// ================================

app.view(/^scheduler_.+/, async ({ ack, body, view, client }) => {
  console.log('📋 Modal submission received for:', body.view.callback_id);

  // Special handling for schedule page submit button
  if (body.view.callback_id === 'scheduler_schedule') {
    console.log('🚀 Schedule page submission starting validation...');

    try {
      const userId = body.user.id;
      let data = formData.get(userId) || {};
      const values = body.view.state.values;
      
      console.log('📋 Raw form values received:', JSON.stringify(values, null, 2));

      // Extract form values
      const extractedChannel = getFormValue(values, 'channel_block', 'channel_select', 'conversation');
      const extractedDate = getFormValue(values, 'date_block', 'date_picker', 'date');
      const extractedTime = getFormValue(values, 'time_block', 'time_picker', 'time');
      const extractedRepeat = getFormValue(values, 'repeat_block', 'repeat_select', 'selected');

      console.log('📋 Extracted values:', {
        channel: extractedChannel,
        date: extractedDate,
        time: extractedTime,
        repeat: extractedRepeat
      });

      // Build validation errors object
      const errors = {};

      // Channel validation
      if (!extractedChannel && !data.channel) {
        errors['channel_block'] = 'Please select a channel to post the message';
      }

      // Help message specific validation
      if (data.type === 'help') {
        const extractedAlertChannels = getFormValue(values, 'alert_channels_block', 'alert_channels_select', 'conversations');
        console.log('🚨 Help validation - extracted alert channels:', extractedAlertChannels);
        
        if (!extractedAlertChannels?.length && (!data.alertChannels || data.alertChannels.length === 0)) {
          errors['alert_channels_block'] = 'Please select at least one alert channel for help notifications';
        }
      }

      // Schedule validation - only if scheduling for later
      const scheduleType = data.scheduleType || 'schedule';
      if (scheduleType === 'schedule') {
        if (!extractedDate && !data.date) {
          errors['date_block'] = 'Please select a date for scheduling';
        }
        if (!extractedTime && !data.time) {
          errors['time_block'] = 'Please select a time for scheduling';
        }
        
        // Check if scheduled time is in the past
        const finalDate = extractedDate || data.date || todayInEST();
        const finalTime = extractedTime || data.time || '09:00';
        const finalRepeat = extractedRepeat || data.repeat || 'none';
        
        if (finalRepeat === 'none' && isDateTimeInPast(finalDate, finalTime)) {
          errors['time_block'] = `Cannot schedule in the past. Current time: ${currentTimeInEST()} EST`;
        }
      }

      // If there are validation errors, return them to display in the modal
      if (Object.keys(errors).length > 0) {
        console.log('❌ Validation errors found:', errors);
        await ack({
          response_action: 'errors',
          errors: errors
        });
        return;
      }

      // If validation passes, acknowledge and process
      await ack();
      console.log('✅ Modal validation passed, processing submission...');

      // Update data with extracted values
      data = {
        ...data,
        channel: extractedChannel || data.channel,
        date: extractedDate || data.date || todayInEST(),
        time: extractedTime || data.time || '09:00',
        repeat: extractedRepeat || data.repeat || 'none'
      };

      // Handle help message alert channels
      if (data.type === 'help') {
        const extractedAlertChannels = getFormValue(values, 'alert_channels_block', 'alert_channels_select', 'conversations');
        data.alertChannels = extractedAlertChannels || data.alertChannels || [];
      }

      console.log('📋 Final processed data:', JSON.stringify(data, null, 2));

      // Generate ID if needed
      if (!data.id) {
        data.id = generateId();
      }

      // Determine final action
      const finalScheduleType = data.scheduleType || 'schedule';
      
      if (finalScheduleType === 'now') {
        // POST NOW
        console.log('📤 Posting message immediately...');
        const success = await sendMessage(data);

        const resultMessage = success ?
          `${data.type.charAt(0).toUpperCase() + data.type.slice(1)} message posted to <#${data.channel}>!${cat()}` :
          `Failed to post message. Please check that I'm invited to <#${data.channel}>.${cat()}`;

        // Send result to user
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
        // SCHEDULE FOR LATER
        console.log('⏰ Scheduling message for later...');
        
        // Add to scheduled messages
        const existingIndex = scheduledMessages.findIndex(m => m.id === data.id);
        if (existingIndex >= 0) {
          scheduledMessages[existingIndex] = data;
          console.log('📝 Updated existing scheduled message');
        } else {
          scheduledMessages.push(data);
          console.log('📝 Added new scheduled message');
        }

        saveMessages();
        scheduleJob(data);

        const successMessage = `${data.type.charAt(0).toUpperCase() + data.type.slice(1)} message scheduled for <#${data.channel}>!${cat()}\n\n${data.date} at ${formatTimeDisplay(data.time)}\nRepeat: ${data.repeat !== 'none' ? data.repeat : 'One-time'}`;

        // Send confirmation to user
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

      // Clean up form data
      formData.delete(userId);
      console.log('🧹 Cleaned up user form data after successful submission');

    } catch (error) {
      // If there's any error during processing, acknowledge with error
      console.error('❌ Error during modal processing:', error);
      await ack({
        response_action: 'errors',
        errors: {
          'channel_block': 'An error occurred processing your request. Please try again.'
        }
      });
    }
  } else {
    // Handle other modal types with simple acknowledgment
    await ack();
  }
});

// ================================
// SCHEDULED MESSAGE MANAGEMENT
// ================================

// Delete scheduled message
app.action(/^delete_message_.+/, async ({ ack, body, client, action }) => {
  await ack();
  try {
    const msgId = action.value;

    // Remove from scheduled messages
    scheduledMessages = scheduledMessages.filter(msg => msg.id !== msgId);

    // Cancel and remove job
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

    console.log(`🗑️ Scheduled message ${msgId} deleted${cat()}`);
  } catch (error) {
    console.error('Delete message error:', error);
  }
});

// ================================
// INTERACTIVE MESSAGE HANDLERS
// ================================

// Enhanced poll voting handler with visual feedback
app.action(/^poll_vote_.+/, async ({ ack, body, client, action }) => {
  await ack();
  try {
    const [, , msgId, optionId] = action.action_id.split('_');
    const user = body.user.id;
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    console.log(`🗳️ Poll vote received: msgId=${msgId}, optionId=${optionId}, user=${user}`);

    // Initialize vote tracking
    if (!pollVotes[msgId]) {
      pollVotes[msgId] = {};
    }

    // Find poll data - check both scheduled messages and active polls
    let pollData = scheduledMessages.find(m => m.id === msgId);
    if (!pollData && messageTs) {
      pollData = activePollMessages.get(messageTs);
    }

    if (!pollData) {
      console.error(`❌ Poll data not found for msgId: ${msgId}`);
      try {
        await client.chat.postEphemeral({
          channel: channel || user,
          user: user,
          text: 'Poll not found. This might be an older poll that is no longer active.'
        });
      } catch (e) {
        console.log('Could not send poll not found message.');
      }
      return;
    }

    const options = (pollData.pollOptions || '').split('\n').filter(Boolean);
    console.log(`📊 Poll options:`, options);

    // Initialize vote tracking for all options
    for (let i = 0; i < options.length; i++) {
      if (!pollVotes[msgId][i]) {
        pollVotes[msgId][i] = new Set();
      }
    }

    const pollType = pollData.pollType || 'single';
    let userVoteChanged = false;

    if (pollType === 'single') {
      // Single choice: remove from all options first, then add to selected
      const wasVotedHere = pollVotes[msgId][optionId].has(user);
      
      // Remove user from all options
      Object.values(pollVotes[msgId]).forEach(set => set.delete(user));
      
      // If they weren't already voted here, add their vote
      if (!wasVotedHere) {
        pollVotes[msgId][optionId].add(user);
      }
      userVoteChanged = true;
      
    } else if (pollType === 'multiple') {
      // Multiple choice: toggle vote for this option only
      if (pollVotes[msgId][optionId].has(user)) {
        pollVotes[msgId][optionId].delete(user);
        console.log(`➖ Removed vote from option ${optionId}`);
      } else {
        pollVotes[msgId][optionId].add(user);
        console.log(`➕ Added vote to option ${optionId}`);
      }
      userVoteChanged = true;
    }

    // Update the poll message with new vote counts if we have the message timestamp
    if (userVoteChanged && messageTs && channel) {
      await updatePollMessage(client, channel, messageTs, pollData, pollVotes[msgId]);
    }

    // Send confirmation to user
    try {
      const voteStatus = pollType === 'single' ? 
        (pollVotes[msgId][optionId].has(user) ? 'Vote recorded' : 'Vote removed') :
        (pollVotes[msgId][optionId].has(user) ? 'Vote added' : 'Vote removed');
        
      await client.chat.postEphemeral({
        channel: channel || user,
        user: user,
        text: `${voteStatus}! ${cat()}`
      });
    } catch (epErr) {
      console.log('Could not send ephemeral vote confirmation.');
    }

    console.log(`✅ Vote processed for user ${user} on poll ${msgId}`);
    
  } catch (error) {
    console.error('❌ Poll vote error:', error);
    
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

// Help button clicks - UPDATED TO FIX DUPLICATE NOTIFICATIONS
app.action(/^help_click_.+/, async ({ ack, body, client, action }) => {
  await ack();
  try {
    const actionData = JSON.parse(action.value);
    const msgId = actionData.msgId;
    const alertChannels = actionData.alertChannels || [];
    const user = body.user.id;
    // body.channel may be undefined in some contexts (e.g., modals / messages outside a channel), guard it
    const channel = body.channel?.id || null;

    if (!alertChannels || alertChannels.length === 0) {
      try {
        await client.chat.postEphemeral({
          channel: channel || user,
          user,
          text: 'No alert channels configured for this help button.'
        });
      } catch (e) {
        console.log('Could not post ephemeral help warning (channel may be missing).');
      }
      return;
    }

    let successCount = 0;
    const alertPromises = alertChannels.map(async (alertChannel) => {
      try {
        await client.chat.postMessage({
          channel: alertChannel,
          text: `🆘 <@${user}> needs backup in ${channel ? `<#${channel}>` : 'this area'}`,
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
      console.log('Could not post ephemeral confirmation (channel missing).');
    }

    // REMOVED: Duplicate message to original channel - this was causing unwanted notifications
    // if (successCount > 0 && channel) {
    //   try {
    //     await client.chat.postMessage({
    //       channel,
    //       text: `🚨 <@${user}> has hit the help button${cat()}`
    //     });
    //     console.log(`🆘 Backup request from ${user} sent to ${successCount}/${alertChannels.length} channels`);
    //   } catch (e) {
    //     console.log('Could not post help confirmation in original channel (maybe missing permissions).');
    //   }
    // }

    console.log(`🆘 Backup request from ${user} sent to ${successCount}/${alertChannels.length} alert channels`);
  } catch (error) {
    console.error('Help button error:', error);
  }
});

// ================================
// DEBUG COMMANDS
// ================================

app.command('/cat-debug', async ({ ack, body, client }) => {
  await ack();

  const channelId = body.channel_id;
  const userId = body.user_id;

  console.log(`🔍 Debug requested by ${userId} in ${channelId}`);

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: 'Running debug tests... check console for details'
  });

  try {
    // Test bot token
    console.log('Test 1: Checking bot token...');
    const authTest = await client.auth.test();
    console.log('✅ Bot token works:', authTest.user);

    // Test channel access
    console.log('Test 2: Checking channel access...');
    const channelInfo = await client.conversations.info({ channel: channelId });
    console.log('✅ Can access channel:', channelInfo.channel.name);

    // Test message posting
    console.log('Test 3: Attempting test message...');
    const testResult = await client.chat.postMessage({
      channel: channelId,
      text: '🧪 Debug test message - if you see this, posting works!'
    });

    if (testResult.ok) {
      console.log('✅ Test message posted successfully!');

      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'Debug complete - message posting works! Test message will be deleted in 5 seconds.'
      });

      // Clean up test message
      setTimeout(async () => {
        try {
          await client.chat.delete({
            channel: channelId,
            ts: testResult.ts
          });
          console.log('🧹 Cleaned up test message');
        } catch (e) {
          console.log('Note: Could not delete test message (normal if no delete permissions)');
        }
      }, 5000);
    }

  } catch (error) {
    console.log('❌ Debug failed:', error);
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

  console.log('🔍 Form data debug requested by', userId);
  console.log('Current user data:', JSON.stringify(userData, null, 2));

  await client.chat.postEphemeral({
    channel: body.channel_id,
    user: userId,
    text: `**Form Data Debug**\n\`\`\`${JSON.stringify(userData, null, 2) || 'No data found'}\`\`\`\n\n**FormData Size:** ${formData.size} users`
  });
});

// ================================
// ERROR HANDLING
// ================================

app.error((error) => {
  console.error('🚨 Global error:', error);
});

// ================================
// CLEANUP & MAINTENANCE
// ================================

cron.schedule('0 * * * *', () => {
  const beforeCount = scheduledMessages.length;
  scheduledMessages = scheduledMessages.filter(msg => {
    if (msg.repeat !== 'none') return true;

    const isPast = isDateTimeInPast(msg.date, msg.time);
    if (isPast) {
      // Clean up job if it exists
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

// ================================
// STARTUP - MOVED KEEP-ALIVE SERVER TO TOP
// ================================

(async () => {
  try {
    // FIXED: Start HTTP server FIRST so Render detects the port immediately
    const keepAliveServer = require('http').createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('PM Squad Bot is running!');
    });

    const PORT = process.env.PORT || 3000;
    keepAliveServer.listen(PORT, () => {
      console.log(`🌐 Keep-alive server running on port ${PORT}`);
    });

    // Now start the Slack app
    await app.start();
    
    console.log('₍^. .^₎⟆ PM Squad Bot "Cat Scratch" is running! (FIXED VERSION)');
    console.log(`₍^. .^₎⟆ Loaded ${scheduledMessages.length} scheduled messages`);
    console.log(`₍^. .^₎⟆ Active jobs: ${jobs.size}`);
    console.log(`₍^. .^₎⟆ Current EST time: ${currentTimeInEST()}`);
    console.log(`₍^. .^₎⟆ Current EST date: ${todayInEST()}`);

    if (scheduledMessages.length > 0) {
      console.log('📋 Scheduled Messages:');
      scheduledMessages.forEach(msg => {
        const nextRun = msg.repeat === 'none' ?
          `${msg.date} at ${msg.time}` :
          `${msg.repeat} at ${msg.time}`;
        console.log(`  - ${msg.type}: ${nextRun} -> #${msg.channel}`);
      });
    }

    console.log('🚀 All systems ready! Use /cat to start.');
  } catch (error) {
    console.error('❌ Failed to start app:', error);
    process.exit(1);
  }
})();

process.on('SIGINT', () => {
  console.log(`👋 ${cat()} Shutting down, cleaning up jobs...`);
  jobs.forEach(job => job.destroy());
  process.exit(0);
});
