/**
 * PM Squad Bot - Unified (Polls + Scheduler)
 * - Navigation uses views.update() (no views.push)
 * - Per-user session state stored in dataStore.userSessions
 * - Centralized submit handlers:
 *    - handleSubmitMessage
 *    - handleSubmitPoll
 * - Clear, direct action_ids for overflow/edit/delete/close
 * - ViewBuilder class abstracts modal builders (clean & reusable)
 *
 * ENV: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
 *
 * npm packages: @slack/bolt node-cron node-schedule (or none if not using schedule),
 *               dotenv
 */

const { App, LogLevel } = require('@slack/bolt');
const cron = require('node-cron');
const schedule = require('node-schedule'); // used for one-off scheduling
const fs = require('fs');
require('dotenv').config();

// ============================================
// Initialization
// ============================================

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG,
  port: process.env.PORT || 3000
});

// ============================================
// Persistent storage (simple file-based) & runtime stores
// ============================================

const SCHEDULE_FILE = './scheduledMessages.json';
let scheduledMessages = [];
const jobs = new Map();                 // cron/node-schedule jobs
const dataStore = {
  polls: new Map(),                     // pollId -> poll object
  scheduledMessages: new Map(),         // msgId -> message object
  activeJobs: new Map(),                // msgId -> job instance
  userSessions: new Map()               // userId -> session form data
};

// Load scheduled messages from disk (best-effort)
function loadScheduledMessages() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const raw = fs.readFileSync(SCHEDULE_FILE, 'utf8');
      const arr = JSON.parse(raw);
      arr.forEach(m => {
        dataStore.scheduledMessages.set(m.id, m);
      });
    }
  } catch (e) {
    console.error('Failed to load scheduled messages:', e);
  }
}
function saveScheduledMessages() {
  try {
    const arr = Array.from(dataStore.scheduledMessages.values());
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error('Failed to save scheduled messages:', e);
  }
}
loadScheduledMessages();

// ============================================
// Utilities
// ============================================

const utils = {
  generateId: (prefix = '') => `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
  todayInEST: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()),
  formatTimeDisplay: (timeStr) => {
    const [hour, minute] = timeStr.split(':').map(Number);
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    return `${displayHour}:${minute.toString().padStart(2, '0')} ${period}`;
  },
  isDateTimeInPast: (dateStr, timeStr) => {
    try {
      const now = new Date();
      const currentDateEST = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(now);
      const currentTimeEST = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).format(now);

      if (dateStr !== currentDateEST) {
        return dateStr < currentDateEST;
      }
      return timeStr < currentTimeEST;
    } catch (e) {
      // conservative fallback: not in the past
      console.error('isDateTimeInPast error', e);
      return false;
    }
  }
};

// Helper to safely pull values from view.state.values
function getFormValue(values, blockId, actionId, type = 'value') {
  try {
    const block = values?.[blockId]?.[actionId];
    if (!block) return null;
    if (type === 'selected') return block?.selected_option?.value;
    if (type === 'conversation') return block?.selected_conversation || block?.value || null;
    if (type === 'conversations') return block?.selected_conversations || [];
    if (type === 'time') return block?.selected_time || null;
    if (type === 'date') return block?.selected_date || null;
    return (block?.value || '').toString();
  } catch (e) {
    console.error('getFormValue error', e);
    return null;
  }
}

// small cat flourish (copied from your older working file)
const cat = () => Math.random() < 0.35 ? ` ${['₍^. .^₎⟆', 'ᓚ₍ ^. .^₎', 'ฅ^•ﻌ•^ฅ'][Math.floor(Math.random() * 3)]}` : '';

// ============================================
// ViewBuilder - builds modal views (reusable)
 // We mirror the patterns from your older working version but keep abstraction for reuse
// ============================================

class ViewBuilder {
  static menu() {
    return {
      type: 'modal',
      callback_id: 'scheduler_menu',
      title: { type: 'plain_text', text: 'Cat Scratch Menu' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Choose a message type:*' } },
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
          elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Scheduled' }, action_id: 'nav_scheduled' }]
        }
      ]
    };
  }

  static scheduledList(userId) {
    const messages = Array.from(dataStore.scheduledMessages.values()).filter(m => m.userId === userId);
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `*Scheduled Messages* (${messages.length} total)` } },
      { type: 'divider' }
    ];

    if (messages.length === 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_No scheduled messages yet_${cat()}` } });
    } else {
      messages.forEach(msg => {
        const nextRun = msg.repeat && msg.repeat !== 'none' ? `${msg.repeat} at ${utils.formatTimeDisplay(msg.time)}` : `${msg.date} at ${utils.formatTimeDisplay(msg.time)}`;
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${msg.title || msg.type}*\n📅 ${nextRun}\n📍 <#${msg.channel}>\n_${(msg.text || '').substring(0, 100)}${(msg.text || '').length > 100 ? '...' : ''}_`
          },
          accessory: {
            type: 'overflow',
            action_id: `msg_overflow_${msg.id}`, // we will match by exact action_ids
            options: [
              { text: { type: 'plain_text', text: 'Edit' }, value: `edit_msg_${msg.id}` },
              { text: { type: 'plain_text', text: 'Delete' }, value: `delete_msg_${msg.id}` },
              { text: { type: 'plain_text', text: 'Send Now' }, value: `send_msg_${msg.id}` }
            ]
          }
        });
      });
    }

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '← Back' }, action_id: 'nav_menu' }
      ]
    });

    return { type: 'modal', callback_id: 'scheduler_scheduled', title: { type: 'plain_text', text: 'Scheduled' }, close: { type: 'plain_text', text: 'Close' }, blocks };
  }

  // Simplified form builders for capacity, help, custom, poll
  static form(page, data = {}) {
    // data is the user's session object for this form
    // page in ['capacity','poll','help','custom']
    const title = `${page.charAt(0).toUpperCase() + page.slice(1)} Message`;
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `*Step 1: Create Your ${page.charAt(0).toUpperCase() + page.slice(1)} Message*` } },
      { type: 'divider' }
    ];

    const addTitleInput = (page !== 'capacity' && page !== 'help');

    if (page === 'capacity') {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_Using default capacity check template. Feel free to customize the message text below._' } });
    }
    if (page === 'help') {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_Using default help button template. Feel free to customize the message text below._' } });
    }

    if (addTitleInput) {
      blocks.push({
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
      });
    }

    blocks.push({
      type: 'input',
      block_id: 'text_block',
      label: { type: 'plain_text', text: 'Message Text' },
      element: {
        type: 'plain_text_input',
        action_id: 'text_input',
        multiline: true,
        initial_value: data.text || (page === 'capacity' ? (data.templates?.capacity || '') : (page === 'help' ? (data.templates?.help || '') : '')),
        placeholder: { type: 'plain_text', text: 'Message content...' }
      }
    });

    // If poll, add poll config controls
    if (page === 'poll') {
      const radioOptions = [
        { text: { type: 'plain_text', text: 'Single Choice' }, value: 'single' },
        { text: { type: 'plain_text', text: 'Multiple Choice' }, value: 'multiple' },
        { text: { type: 'plain_text', text: 'Open Discussion' }, value: 'open' }
      ];
      const selectedType = data.pollType || 'single';
      const initialOption = radioOptions.find(r => r.value === selectedType) || radioOptions[0];

      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        block_id: 'poll_type_section',
        text: { type: 'mrkdwn', text: 'How should people vote?' },
        accessory: {
          type: 'radio_buttons',
          action_id: 'poll_type_radio',
          options: radioOptions,
          initial_option: initialOption
        }
      });

      if (selectedType !== 'open') {
        blocks.push({ type: 'divider' });
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Poll Options*' } });

        const options = (data.pollOptions ? data.pollOptions.split('\n').filter(Boolean) : ['Option 1', 'Option 2']);
        options.forEach((opt, idx) => {
          blocks.push({
            type: 'input',
            block_id: `option_${idx}_block`,
            label: { type: 'plain_text', text: `Option ${idx + 1}` },
            element: {
              type: 'plain_text_input',
              action_id: `option_${idx}_input`,
              initial_value: opt || '',
              placeholder: { type: 'plain_text', text: `Enter option ${idx + 1}...` }
            },
            optional: idx >= 2
          });
        });

        // Option management
        const actionElements = [];
        if (options.length < 10) actionElements.push({ type: 'button', text: { type: 'plain_text', text: 'Add Option' }, action_id: 'add_poll_option' });
        if (options.length > 2) actionElements.push({ type: 'button', text: { type: 'plain_text', text: 'Remove Last Option' }, action_id: 'remove_poll_option', style: 'danger' });
        if (actionElements.length > 0) blocks.push({ type: 'actions', elements: actionElements });

        // Settings
        blocks.push({ type: 'divider' });
        blocks.push({
          type: 'section',
          block_id: 'poll_settings_section',
          text: { type: 'mrkdwn', text: 'Display options:' },
          accessory: {
            type: 'checkboxes',
            action_id: 'poll_settings_checkboxes',
            options: [
              { text: { type: 'plain_text', text: 'Show vote counts' }, value: 'show_counts' },
              { text: { type: 'plain_text', text: 'Anonymous voting' }, value: 'anonymous' }
            ],
            initial_options: (data.pollSettings || []).map(s => ({ text: { type: 'plain_text', text: s }, value: s }))
          }
        });
      } else {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: "_Open discussion polls don't need predefined options. Responses happen in thread._" } });
      }
    }

    // Action buttons
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '← Back' }, action_id: 'nav_menu' },
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Preview Message' }, action_id: 'nav_preview' }
      ]
    });

    return {
      type: 'modal',
      callback_id: `scheduler_${page}`,
      title: { type: 'plain_text', text: title },
      submit: { type: 'plain_text', text: 'Preview Message' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks
    };
  }

  static preview(data = {}) {
    // data: session data
    const previewTextParts = [];
    if (data.title) previewTextParts.push(`*${data.title}*`);
    if (data.text) previewTextParts.push(data.text);

    if (data.type === 'poll') {
      if (data.pollOptions && data.pollType !== 'open') {
        previewTextParts.push('\n' + data.pollOptions.split('\n').map((o, i) => `${i + 1}. ${o}`).join('\n'));
      } else if (data.pollType === 'open') {
        previewTextParts.push('\n_Open discussion - responses in thread_');
      }
    }

    const previewBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Preview:*\n\`\`\`${previewTextParts.join('\n\n').substring(0, 500)}${previewTextParts.join('\n\n').length > 500 ? '...' : ''}\`\`\`${cat()}`
      }
    };

    return {
      type: 'modal',
      callback_id: 'scheduler_preview',
      title: { type: 'plain_text', text: `${(data.type || 'Message').charAt(0).toUpperCase() + (data.type || 'Message').slice(1)} Preview` },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Step 2: Preview Your Message*' } },
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

  static schedule(data = {}) {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: '*Step 3: Send or Schedule Message*' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Where to send:*' } },
      {
        type: 'input',
        block_id: 'channel_block',
        label: { type: 'plain_text', text: 'Target Channel' },
        element: {
          type: 'conversations_select',
          action_id: 'channel_select',
          ...(data.channel ? { initial_conversation: data.channel } : {}),
          placeholder: { type: 'plain_text', text: 'Select channel to post message' }
        }
      }
    ];

    if (data.type === 'help') {
      blocks.push({
        type: 'input',
        block_id: 'alert_channels_block',
        label: { type: 'plain_text', text: 'Alert Channels' },
        element: {
          type: 'multi_conversations_select',
          action_id: 'alert_channels_select',
          ...(data.alertChannels ? { initial_conversations: data.alertChannels } : {}),
          placeholder: { type: 'plain_text', text: 'Channels to notify when help is requested' }
        },
        hint: { type: 'plain_text', text: 'Select channels that will be alerted when someone clicks the help button' }
      });
    }

    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*When to send this message:*' } });
    blocks.push({
      type: 'actions',
      block_id: 'send_timing_block',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🐈‍⬛ Post Now' },
          style: data.scheduleType === 'now' ? 'primary' : undefined,
          action_id: 'timing_now'
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🧶 Schedule for Later' },
          style: data.scheduleType === 'schedule' || !data.scheduleType ? 'primary' : undefined,
          action_id: 'timing_schedule'
        }
      ]
    });

    if (data.scheduleType === 'schedule' || !data.scheduleType) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Schedule Details:*' } });
      blocks.push({
        type: 'actions',
        block_id: 'datetime_block',
        elements: [
          {
            type: 'datepicker',
            action_id: 'date_picker',
            initial_date: data.date || utils.todayInEST()
          },
          {
            type: 'timepicker',
            action_id: 'time_picker',
            initial_time: data.time || '09:00'
          }
        ]
      });
      blocks.push({
        type: 'input',
        block_id: 'repeat_block',
        label: { type: 'plain_text', text: 'Repeat Schedule' },
        element: {
          type: 'static_select',
          action_id: 'repeat_select',
          initial_option: data.repeat === 'daily' ? { text: { type: 'plain_text', text: 'Daily' }, value: 'daily' } :
            data.repeat === 'weekly' ? { text: { type: 'plain_text', text: 'Weekly' }, value: 'weekly' } :
              data.repeat === 'monthly' ? { text: { type: 'plain_text', text: 'Monthly' }, value: 'monthly' } :
                { text: { type: 'plain_text', text: 'None (One-time)' }, value: 'none' },
          options: [
            { text: { type: 'plain_text', text: 'None (One-time)' }, value: 'none' },
            { text: { type: 'plain_text', text: 'Daily' }, value: 'daily' },
            { text: { type: 'plain_text', text: 'Weekly' }, value: 'weekly' },
            { text: { type: 'plain_text', text: 'Monthly' }, value: 'monthly' }
          ]
        }
      });
    }

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '← Back to Preview' }, action_id: 'nav_preview' },
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Post' }, action_id: 'submit_message' }
      ]
    });

    return {
      type: 'modal',
      callback_id: 'scheduler_schedule',
      title: { type: 'plain_text', text: 'Send or Schedule Message' },
      submit: { type: 'plain_text', text: 'Post' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks
    };
  }
}

// ============================================
// Common handlers (Slash command entrypoint)
// ============================================

app.command('/cat', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: ViewBuilder.menu()
    });
    logger.info(`Opened menu for ${body.user_id}`);
  } catch (e) {
    console.error('Failed to open menu', e);
  }
});

// ============================================
// Navigation handlers (use views.update only)
// - nav_menu, nav_scheduled, nav_preview, nav_schedule
// - form-type handlers: nav_capacity, nav_poll, nav_help, nav_custom
// ============================================

['nav_menu', 'nav_scheduled', 'nav_preview', 'nav_schedule'].forEach(actionId => {
  app.action(actionId, async ({ ack, body, client }) => {
    await ack();
    const page = actionId.replace('nav_', '');
    const userId = body.user.id;

    try {
      let session = dataStore.userSessions.get(userId) || {};
      // For preview/schedule we need to extract current view state
      if ((page === 'preview' || page === 'schedule') && body.view?.state?.values) {
        const values = body.view.state.values;

        // Title (if present)
        if (values.title_block?.title_input) {
          session.title = getFormValue(values, 'title_block', 'title_input') || session.title;
        }

        // Text (always)
        session.text = getFormValue(values, 'text_block', 'text_input') || session.text;

        // Poll-specific extraction
        if (session.type === 'poll') {
          // poll type radio
          const pollType = values?.poll_type_section?.poll_type_radio?.selected_option?.value;
          session.pollType = pollType || session.pollType || 'single';

          // poll options
          if (session.pollType !== 'open') {
            const opts = [];
            let idx = 0;
            while (values[`option_${idx}_block`]) {
              const v = getFormValue(values, `option_${idx}_block`, `option_${idx}_input`);
              if (v) opts.push(v);
              idx++;
            }
            if (opts.length > 0) session.pollOptions = opts.join('\n');
          }

          // settings checkboxes
          const pollSettingsSel = values?.poll_settings_section?.poll_settings_checkboxes?.selected_options || [];
          session.pollSettings = pollSettingsSel.map(s => s.value);
        }

        // channel & scheduling extraction
        session.channel = getFormValue(values, 'channel_block', 'channel_select', 'conversation') || session.channel;
        const dateVal = getFormValue(values, 'datetime_block', 'date_picker', 'date');
        const timeVal = getFormValue(values, 'datetime_block', 'time_picker', 'time');
        const repeatVal = getFormValue(values, 'repeat_block', 'repeat_select', 'selected');

        if (dateVal) session.date = dateVal;
        if (timeVal) session.time = timeVal;
        if (repeatVal) session.repeat = repeatVal;

        // alertChannels for help
        if (session.type === 'help') {
          const alertChannels = getFormValue(values, 'alert_channels_block', 'alert_channels_select', 'conversations');
          if (alertChannels) session.alertChannels = alertChannels;
        }

        dataStore.userSessions.set(userId, session);
      }

      // Build the appropriate view
      let nextView;
      if (page === 'menu') {
        nextView = ViewBuilder.menu();
      } else if (page === 'scheduled') {
        nextView = ViewBuilder.scheduledList(userId);
      } else if (page === 'preview') {
        nextView = ViewBuilder.preview(session);
      } else if (page === 'schedule') {
        nextView = ViewBuilder.schedule(session);
      } else {
        nextView = ViewBuilder.menu();
      }

      await client.views.update({
        view_id: body.view.id,
        view: nextView
      });
    } catch (e) {
      console.error(`Navigation ${actionId} error:`, e);
    }
  });
});

['nav_capacity', 'nav_poll', 'nav_help', 'nav_custom'].forEach(actionId => {
  app.action(actionId, async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;
    const messageType = actionId.replace('nav_', '');

    try {
      let session = dataStore.userSessions.get(userId) || {};
      // If switching type, reset relevant fields
      if (!session.type || session.type !== messageType) {
        if (messageType === 'capacity') {
          session = { type: 'capacity', title: '', text: '', scheduleType: 'schedule' };
        } else if (messageType === 'help') {
          session = { type: 'help', title: '', text: '', alertChannels: [], scheduleType: 'schedule' };
        } else if (messageType === 'poll') {
          session = { type: 'poll', title: '', text: '', pollType: 'single', pollOptions: 'Option 1\nOption 2', pollSettings: [], scheduleType: 'schedule' };
        } else {
          session = { type: 'custom', title: '', text: '', scheduleType: 'schedule' };
        }
      } else {
        // returning to existing message type; ensure defaults exist
        session.type = messageType;
      }

      dataStore.userSessions.set(userId, session);

      await client.views.update({
        view_id: body.view.id,
        view: ViewBuilder.form(messageType, session)
      });
    } catch (e) {
      console.error(`${actionId} handler error`, e);
    }
  });
});

// ============================================
// Poll form interactive handlers (add/remove option, poll type, settings)
// ============================================

app.action('poll_type_radio', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const selectedType = body.actions[0].selected_option.value;
    const session = dataStore.userSessions.get(userId) || {};
    session.pollType = selectedType;
    if (selectedType === 'open') session.pollOptions = ''; // clear options
    dataStore.userSessions.set(userId, session);
    await client.views.update({ view_id: body.view.id, view: ViewBuilder.form('poll', session) });
  } catch (e) {
    console.error('poll_type_radio error', e);
  }
});

app.action('add_poll_option', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const session = dataStore.userSessions.get(userId) || {};
    // extract existing options from view
    const values = body.view.state.values;
    const opts = [];
    let idx = 0;
    while (values[`option_${idx}_block`]) {
      const v = getFormValue(values, `option_${idx}_block`, `option_${idx}_input`);
      if (v) opts.push(v);
      idx++;
    }
    opts.push(`Option ${opts.length + 1}`);
    session.pollOptions = opts.join('\n');
    dataStore.userSessions.set(userId, session);
    await client.views.update({ view_id: body.view.id, view: ViewBuilder.form('poll', session) });
  } catch (e) {
    console.error('add_poll_option error', e);
  }
});

app.action('remove_poll_option', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const session = dataStore.userSessions.get(userId) || {};
    const values = body.view.state.values;
    const opts = [];
    let idx = 0;
    while (values[`option_${idx}_block`]) {
      const v = getFormValue(values, `option_${idx}_block`, `option_${idx}_input`);
      if (v) opts.push(v);
      idx++;
    }
    if (opts.length > 2) opts.pop();
    session.pollOptions = opts.join('\n');
    dataStore.userSessions.set(userId, session);
    await client.views.update({ view_id: body.view.id, view: ViewBuilder.form('poll', session) });
  } catch (e) {
    console.error('remove_poll_option error', e);
  }
});

app.action('poll_settings_checkboxes', async ({ ack, body }) => {
  await ack();
  try {
    const userId = body.user.id;
    const session = dataStore.userSessions.get(userId) || {};
    const selected = body.actions[0].selected_options || [];
    session.pollSettings = selected.map(s => s.value);
    dataStore.userSessions.set(userId, session);
  } catch (e) {
    console.error('poll_settings_checkboxes error', e);
  }
});

// ============================================
// Schedule page specific handlers: timing buttons, channel select
// ============================================

app.action('timing_now', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const session = dataStore.userSessions.get(userId) || {};
    session.scheduleType = 'now';
    dataStore.userSessions.set(userId, session);
    await client.views.update({ view_id: body.view.id, view: ViewBuilder.schedule(session) });
  } catch (e) {
    console.error('timing_now error', e);
  }
});

app.action('timing_schedule', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const session = dataStore.userSessions.get(userId) || {};
    session.scheduleType = 'schedule';
    dataStore.userSessions.set(userId, session);
    await client.views.update({ view_id: body.view.id, view: ViewBuilder.schedule(session) });
  } catch (e) {
    console.error('timing_schedule error', e);
  }
});

app.action('channel_select', async ({ ack, body, client }) => {
  await ack();
  try {
    const userId = body.user.id;
    const selectedChannel = body.actions[0].selected_conversation;
    const session = dataStore.userSessions.get(userId) || {};
    session.channel = selectedChannel;
    dataStore.userSessions.set(userId, session);
    // Optionally verify channel access
    try {
      const info = await client.conversations.info({ channel: selectedChannel });
      console.log('channel_select verified', info.channel.id);
    } catch (err) {
      console.warn('channel_select verification failed', err?.data?.error);
    }
  } catch (e) {
    console.error('channel_select error', e);
  }
});

// ============================================
// Submit/Posting handlers
// - submit_message: posts or schedules messages (centralized)
// - submit_poll: creates and posts poll (centralized)
// ============================================

async function scheduleJobForMessage(msg, client) {
  // Cancel existing
  try {
    if (dataStore.activeJobs.has(msg.id)) {
      const j = dataStore.activeJobs.get(msg.id);
      j.cancel?.();
      dataStore.activeJobs.delete(msg.id);
    }
  } catch (e) { /* ignore */ }

  // Recurring with cron OR one-off with node-schedule
  if (msg.repeat && msg.repeat !== 'none') {
    // cron expression
    const [hh, mm] = (msg.time || '09:00').split(':').map(Number);
    let cronExpr;
    if (msg.repeat === 'daily') cronExpr = `${mm} ${hh} * * *`;
    else if (msg.repeat === 'weekly') {
      const day = new Date(msg.date).getDay();
      cronExpr = `${mm} ${hh} * * ${day}`;
    } else if (msg.repeat === 'monthly') {
      const day = msg.date.split('-')[2];
      cronExpr = `${mm} ${hh} ${day} * *`;
    }

    if (cronExpr) {
      const job = cron.schedule(cronExpr, async () => {
        await sendMessageToChannel(msg, client);
      }, { timezone: 'America/New_York' });
      dataStore.activeJobs.set(msg.id, job);
      console.log('scheduled recurring job', cronExpr, msg.id);
    }
  } else {
    // one-time
    const dateParts = (msg.date || utils.todayInEST()).split('-').map(Number); // YYYY-MM-DD
    const [y, mon, d] = dateParts;
    const [hh, mm] = (msg.time || '09:00').split(':').map(Number);
    const when = new Date(y, mon - 1, d, hh, mm, 0);
    if (when > new Date()) {
      const job = schedule.scheduleJob(when, async () => {
        await sendMessageToChannel(msg, client);
        // clean up
        if (msg.repeat === 'none') {
          dataStore.scheduledMessages.delete(msg.id);
          saveScheduledMessages();
        }
      });
      dataStore.activeJobs.set(msg.id, job);
      console.log('scheduled one-time job', when.toISOString(), msg.id);
    } else {
      console.log('one-time schedule time in past; skipping job scheduling', msg.id);
    }
  }
}

async function sendMessageToChannel(msg, client) {
  try {
    if (!msg.channel) throw new Error('No channel specified');
    if (msg.type === 'capacity' || msg.type === 'custom' || msg.type === 'help') {
      const text = (msg.title ? `*${msg.title}*\n` : '') + (msg.text || '') + cat();
      const res = await client.chat.postMessage({ channel: msg.channel, text });
      console.log('posted message', res.ts);
      if (msg.type === 'capacity' && res.ok && res.ts) {
        try {
          await client.reactions.add({ channel: msg.channel, timestamp: res.ts, name: 'black_cat' });
        } catch (e) { /* ignore reaction errors */ }
      }
      return res.ok;
    } else if (msg.type === 'poll') {
      // Build poll blocks
      let blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${msg.title || 'Poll'}*${cat()}\n${msg.text || ''}` } }];
      if (msg.pollType !== 'open') {
        const options = (msg.pollOptions || '').split('\n').filter(Boolean);
        const buttonEls = options.map((opt, idx) => ({
          type: 'button',
          text: { type: 'plain_text', text: opt.slice(0, 75) },
          action_id: `poll_vote_${msg.id}_${idx}`,
          value: `${idx}`
        }));
        for (let i = 0; i < buttonEls.length; i += 5) {
          blocks.push({ type: 'actions', block_id: `poll_${msg.id}_${i}`, elements: buttonEls.slice(i, i + 5) });
        }
      } else {
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Open discussion - respond in thread_' }] });
      }
      const res = await client.chat.postMessage({ channel: msg.channel, text: msg.title || 'Poll', blocks });
      // store messageTs if needed for vote updates
      if (res.ok && res.ts) {
        // Persist poll messageTs if we created a poll object earlier
        if (dataStore.polls.has(msg.id)) {
          const p = dataStore.polls.get(msg.id);
          p.messageTs = res.ts;
          p.channel = msg.channel;
          dataStore.polls.set(msg.id, p);
        }
      }
      return res.ok;
    }
  } catch (e) {
    console.error('sendMessageToChannel error', e);
    return false;
  }
}

async function handleSubmitMessage(body, client) {
  const userId = body.user.id;
  const session = dataStore.userSessions.get(userId) || {};
  const values = body.view?.state?.values || {};

  // extract state (similar logic used earlier)
  if (values.title_block?.title_input) session.title = getFormValue(values, 'title_block', 'title_input') || session.title;
  session.text = getFormValue(values, 'text_block', 'text_input') || session.text;
  session.channel = getFormValue(values, 'channel_block', 'channel_select', 'conversation') || session.channel;
  const dateVal = getFormValue(values, 'datetime_block', 'date_picker', 'date');
  const timeVal = getFormValue(values, 'datetime_block', 'time_picker', 'time');
  const repeatVal = getFormValue(values, 'repeat_block', 'repeat_select', 'selected');
  if (dateVal) session.date = dateVal;
  if (timeVal) session.time = timeVal;
  if (repeatVal) session.repeat = repeatVal;
  if (session.type === 'help') {
    const alertCh = getFormValue(values, 'alert_channels_block', 'alert_channels_select', 'conversations');
    if (alertCh) session.alertChannels = alertCh;
  }

  // default values
  session.scheduleType = session.scheduleType || 'schedule';
  session.repeat = session.repeat || 'none';
  session.time = session.time || '09:00';
  session.date = session.date || utils.todayInEST();

  // Validation
  if (!session.channel) {
    await client.chat.postEphemeral({ channel: body.user.id, user: userId, text: `Please select a channel first.${cat()}` });
    return;
  }
  if (session.scheduleType === 'schedule' && session.repeat === 'none' && utils.isDateTimeInPast(session.date, session.time)) {
    await client.chat.postEphemeral({ channel: body.user.id, user: userId, text: `Cannot schedule messages in the past.${cat()}` });
    return;
  }
  if (session.type === 'help' && (!session.alertChannels || session.alertChannels.length === 0)) {
    await client.chat.postEphemeral({ channel: body.user.id, user: userId, text: `Please select at least one alert channel for help notifications.${cat()}` });
    return;
  }

  // create message object
  if (!session.id) session.id = utils.generateId('msg_');
  const messageObj = {
    id: session.id,
    userId,
    type: session.type || 'custom',
    title: session.title || '',
    text: session.text || '',
    channel: session.channel,
    scheduleType: session.scheduleType,
    date: session.date,
    time: session.time,
    repeat: session.repeat,
    alertChannels: session.alertChannels || []
  };

  if (session.scheduleType === 'now') {
    // post immediately
    const success = await sendMessageToChannel(messageObj, client);
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: success ? 'Message Posted!' : 'Post Failed' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: success ? `${messageObj.type} message posted to <#${messageObj.channel}>!${cat()}` : `Failed to post to <#${messageObj.channel}>. Make sure I'm invited.` } }]
      }
    });
  } else {
    // schedule for later: persist and schedule
    dataStore.scheduledMessages.set(messageObj.id, messageObj);
    saveScheduledMessages();
    await scheduleJobForMessage(messageObj, client);
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Message Scheduled!' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${messageObj.type} message scheduled for <#${messageObj.channel}>!${cat()}\n\n${messageObj.date} at ${utils.formatTimeDisplay(messageObj.time)}\nRepeat: ${messageObj.repeat !== 'none' ? messageObj.repeat : 'One-time'}` } }]
      }
    });
  }

  // clear session
  dataStore.userSessions.delete(userId);
}

async function handleSubmitPoll(body, client) {
  const userId = body.user.id;
  const session = dataStore.userSessions.get(userId) || {};
  const values = body.view?.state?.values || {};

  // extract poll details
  session.title = getFormValue(values, 'title_block', 'title_input') || session.title;
  session.text = getFormValue(values, 'text_block', 'text_input') || session.text;
  session.pollType = values?.poll_type_section?.poll_type_radio?.selected_option?.value || session.pollType || 'single';
  // options
  if (session.pollType !== 'open') {
    const opts = [];
    let idx = 0;
    while (values[`option_${idx}_block`]) {
      const v = getFormValue(values, `option_${idx}_block`, `option_${idx}_input`);
      if (v) opts.push(v);
      idx++;
    }
    if (opts.length > 0) session.pollOptions = opts.join('\n');
  }
  // settings
  session.pollSettings = (values?.poll_settings_section?.poll_settings_checkboxes?.selected_options || []).map(o => o.value);

  // channel/schedule extraction (if present)
  session.channel = getFormValue(values, 'channel_block', 'channel_select', 'conversation') || session.channel;
  const dateVal = getFormValue(values, 'datetime_block', 'date_picker', 'date');
  const timeVal = getFormValue(values, 'datetime_block', 'time_picker', 'time');
  const repeatVal = getFormValue(values, 'repeat_block', 'repeat_select', 'selected');
  if (dateVal) session.date = dateVal;
  if (timeVal) session.time = timeVal;
  if (repeatVal) session.repeat = repeatVal;
  session.scheduleType = session.scheduleType || 'schedule';
  session.repeat = session.repeat || 'none';
  session.time = session.time || '09:00';
  session.date = session.date || utils.todayInEST();

  // validation
  if (!session.channel) {
    await client.chat.postEphemeral({ channel: body.user.id, user: userId, text: `Please select a channel first.${cat()}` });
    return;
  }
  if (session.pollType !== 'open') {
    const optCount = (session.pollOptions || '').split('\n').filter(Boolean).length;
    if (optCount < 2) {
      await client.chat.postEphemeral({ channel: body.user.id, user: userId, text: `Please provide at least 2 poll options.${cat()}` });
      return;
    }
  }

  // Create poll object and persist
  if (!session.id) session.id = utils.generateId('poll_');
  const pollObj = {
    id: session.id,
    creator: userId,
    channel: session.channel,
    title: session.title,
    text: session.text,
    pollType: session.pollType,
    pollOptions: session.pollOptions || '',
    pollSettings: session.pollSettings || [],
    created: new Date().toISOString(),
    votes: {}, // userId -> [optionIndices]
    status: 'active',
    messageTs: null
  };
  dataStore.polls.set(pollObj.id, pollObj);

  // post poll (similar to sendMessageToChannel but keep poll object updated)
  const options = (pollObj.pollOptions || '').split('\n').filter(Boolean);
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${pollObj.title || 'Poll'}*${cat()}\n${pollObj.text || ''}` } }];
  if (pollObj.pollType !== 'open') {
    const buttonEls = options.map((opt, idx) => ({
      type: 'button',
      text: { type: 'plain_text', text: opt.slice(0, 75) },
      action_id: `poll_vote_${pollObj.id}_${idx}`,
      value: `${idx}`
    }));
    for (let i = 0; i < buttonEls.length; i += 5) {
      blocks.push({ type: 'actions', block_id: `poll_${pollObj.id}_${i}`, elements: buttonEls.slice(i, i + 5) });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: pollObj.pollType === 'single' ? '_Click to vote. Click again to unvote._' : '_Click to vote (multiple). Click again to unvote._' }] });
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Open discussion - respond in thread._' }] });
  }

  try {
    const res = await client.chat.postMessage({ channel: pollObj.channel, text: pollObj.title || 'Poll', blocks });
    if (res.ok && res.ts) {
      pollObj.messageTs = res.ts;
      dataStore.polls.set(pollObj.id, pollObj);
    }
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Poll Posted!' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Poll posted to <#${pollObj.channel}>!${cat()}` } }]
      }
    });
  } catch (e) {
    console.error('handleSubmitPoll error', e);
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Poll Failed' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Failed to post poll. ${e.message}` } }]
      }
    });
  }

  // clear session
  dataStore.userSessions.delete(userId);
}

// Wire up submit actions: schedule page top-level submit and action button both call handleSubmitMessage
app.view(/^scheduler_/, async ({ ack, body, view, client }) => {
  // ack to avoid timeouts; we'll process quickly
  await ack();

  const callback = body.view.callback_id;
  try {
    if (callback === 'scheduler_schedule') {
      // schedule page submit
      await handleSubmitMessage(body, client);
    } else if (callback === 'scheduler_poll') {
      // shouldn't happen - polls use submit via nav flow - but guard
      await handleSubmitPoll(body, client);
    } else {
      // other modals may just be preview; no-op
      // (we keep view submissions simple; most navigation uses action buttons)
    }
  } catch (e) {
    console.error('view submission error', e);
  }
});

// action button on schedule page
app.action('submit_message', async ({ ack, body, client }) => {
  await ack();
  try {
    await handleSubmitMessage(body, client);
  } catch (e) {
    console.error('submit_message error', e);
    try {
      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Error' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'An error occurred. Check logs.' } }]
        }
      });
    } catch (u) { console.error('Failed to show error modal', u); }
  }
});

// Poll submit via a 'submit_poll' action (we'll wire preview -> schedule -> submit pattern)
app.action('submit_poll', async ({ ack, body, client }) => {
  await ack();
  try {
    await handleSubmitPoll(body, client);
  } catch (e) {
    console.error('submit_poll error', e);
  }
});

// ============================================
// Overflow / direct action handlers (delete/edit/send/close) for messages & polls
// We use simple action ids / overflow options (e.g., delete_msg_<id>, edit_msg_<id>)
// ============================================

// Messages overflow option value parsing helper
function parseOverflowValue(val) {
  // Expected patterns: 'edit_msg_<id>', 'delete_msg_<id>', 'send_msg_<id>'
  const parts = (val || '').split('_');
  const action = parts[0];
  const type = parts[1];
  const id = parts.slice(2).join('_');
  return { action, type, id };
}

// catch overflow actions using regex
app.action(/^msg_overflow_.*/, async ({ ack, body, client }) => {
  await ack();
  try {
    const selected = body.actions[0].selected_option?.value || body.actions[0].value;
    if (!selected) {
      console.warn('msg_overflow missing selected value', body.actions[0]);
      return;
    }
    const { action, type, id } = parseOverflowValue(selected);
    const userId = body.user.id;

    if (action === 'edit' && type === 'msg') {
      const msg = dataStore.scheduledMessages.get(id);
      if (!msg) {
        await client.chat.postEphemeral({ channel: userId, user: userId, text: `Message not found.` });
        return;
      }
      // push or update modal? We're using update to replace current modal with the edit form
      // build a session object from existing message
      const session = { ...msg };
      dataStore.userSessions.set(userId, session);
      await client.views.update({ view_id: body.view.id, view: ViewBuilder.form(msg.type, session) });
    } else if (action === 'delete' && type === 'msg') {
      // remove from datastore and cancel job
      dataStore.scheduledMessages.delete(id);
      if (dataStore.activeJobs.has(id)) {
        const job = dataStore.activeJobs.get(id);
        try { job.cancel?.(); } catch (e) { /* ignore */ }
        dataStore.activeJobs.delete(id);
      }
      saveScheduledMessages();
      // refresh scheduled list view
      await client.views.update({ view_id: body.view.id, view: ViewBuilder.scheduledList(body.user.id) });
    } else if (action === 'send' && type === 'msg') {
      const msg = dataStore.scheduledMessages.get(id);
      if (msg) {
        await sendMessageToChannel(msg, client);
      }
    } else {
      console.warn('Unhandled msg overflow action', action, type, id);
    }
  } catch (e) {
    console.error('msg_overflow handler error', e);
  }
});

// Polls overflow - similar approach for poll objects
app.action(/^poll_overflow_.*/, async ({ ack, body, client }) => {
  await ack();
  try {
    const selected = body.actions[0].selected_option?.value || body.actions[0].value;
    if (!selected) {
      console.warn('poll_overflow missing selected value', body.actions[0]);
      return;
    }
    const parts = selected.split('_'); // e.g., close_poll_<id>, delete_poll_<id>
    const action = parts[0];
    const type = parts[1];
    const id = parts.slice(2).join('_');

    if (action === 'close' && type === 'poll') {
      const poll = dataStore.polls.get(id);
      if (poll) {
        poll.status = 'closed';
        // post results
        const results = {};
        (poll.options || []).forEach(opt => results[opt] = 0);
        Object.values(poll.votes || {}).forEach(userVotes => {
          userVotes.forEach(v => { if (results[v] !== undefined) results[v]++; });
        });
        const total = Object.keys(poll.votes || {}).length;
        const blocks = [{ type: 'header', text: { type: 'plain_text', text: '📊 Poll Results' } }, { type: 'section', text: { type: 'mrkdwn', text: `*${poll.question}*` } }, { type: 'divider' }];
        Object.entries(results).forEach(([option, votes]) => {
          const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${option}*\n${pct}% (${votes} votes)` } });
        });
        await client.chat.postMessage({ channel: poll.channel, blocks, text: `Poll closed: ${poll.question}` });
      }
    } else if (action === 'delete' && type === 'poll') {
      dataStore.polls.delete(id);
      await client.views.update({ view_id: body.view.id, view: ViewBuilder.menu() });
    } else {
      console.warn('Unhandled poll overflow action', action, type, id);
    }
  } catch (e) {
    console.error('poll_overflow handler error', e);
  }
});

// ============================================
// Vote handlers for polls
// action id pattern: poll_vote_<pollId>_<idx>
// ============================================

app.action(/^poll_vote_.*/, async ({ ack, body, client }) => {
  await ack();
  try {
    const actionId = body.actions[0].action_id; // e.g., poll_vote_poll_12345_0
    const [ , , pollId, idxStr ] = actionId.split('_');
    const idx = parseInt(idxStr, 10);
    const poll = dataStore.polls.get(pollId);
    if (!poll || poll.status !== 'active') return;
    const userId = body.user.id;
    const option = (poll.pollOptions || '').split('\n')[idx];
    if (!option) return;

    // manage votes
    if (!poll.votes) poll.votes = {};
    if (!poll.votes[userId]) poll.votes[userId] = [];

    if (poll.pollType === 'multiple') {
      const pos = poll.votes[userId].indexOf(option);
      if (pos > -1) poll.votes[userId].splice(pos, 1);
      else poll.votes[userId].push(option);
    } else {
      // single choice - overwrite
      if (poll.votes[userId].length === 1 && poll.votes[userId][0] === option) {
        // same vote -> unvote
        poll.votes[userId] = [];
      } else {
        poll.votes[userId] = [option];
      }
    }

    dataStore.polls.set(pollId, poll);

    // update original poll message if we have messageTs
    if (poll.messageTs && poll.channel) {
      // rebuild blocks with counts
      const options = (poll.pollOptions || '').split('\n').filter(Boolean);
      const blocks = [{ type: 'header', text: { type: 'plain_text', text: poll.question || poll.title || 'Poll' } }];
      blocks.push({ type: 'divider' });
      const elements = options.map((opt, i) => {
        const votes = Object.values(poll.votes || {}).filter(vs => vs.includes(opt)).length;
        return {
          type: 'button',
          text: { type: 'plain_text', text: `${opt} (${votes})` },
          action_id: `poll_vote_${pollId}_${i}`,
          value: `${i}`
        };
      });
      for (let i = 0; i < elements.length; i += 5) {
        blocks.push({ type: 'actions', elements: elements.slice(i, i + 5) });
      }
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${Object.keys(poll.votes || {}).length} votes` }] });

      try {
        await client.chat.update({ channel: poll.channel, ts: poll.messageTs, blocks, text: poll.title || 'Poll' });
      } catch (e) {
        console.error('Failed to update poll message', e);
      }
    }

    // ephemeral confirmation
    try {
      await client.chat.postEphemeral({ channel: body.channel?.id || poll.channel, user: userId, text: `✅ Vote recorded!` });
    } catch (e) {
      // ignore ephemeral errors
    }
  } catch (e) {
    console.error('poll_vote handler error', e);
  }
});

// ============================================
// Startup: re-schedule any persisted scheduled messages
// ============================================

(async () => {
  try {
    for (const msg of Array.from(dataStore.scheduledMessages.values())) {
      // schedule only if not completed (repeat none & in past)
      if (msg.repeat === 'none' && utils.isDateTimeInPast(msg.date, msg.time)) {
        // don't schedule
        continue;
      }
      await scheduleJobForMessage(msg, app.client);
    }

    await app.start();
    console.log('⚡ PM Squad Bot (Polls + Scheduler) is running!');
  } catch (e) {
    console.error('Failed to start app', e);
    process.exit(1);
  }
})();
