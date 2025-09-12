/*
master.js - Slack Cat Messaging App
MongoDB persistence + JSON fallback
Full scheduling, preview, message library
*/

const fs = require('fs');
const { App, LogLevel } = require('@slack/bolt');
const cron = require('node-cron');
const schedule = require('node-schedule');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://mollymarieobrien_db_user:8sg2dGl9ou4w50YS@catscratch.ghhqmpz.mongodb.net/catscratch?retryWrites=true&w=majority&appName=catscratch';
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'catscratch';
const SCHEDULE_JSON_FILE = './scheduledMessages.json';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
  port: PORT
});

let mongoClient = null;
let messagesCol = null;
const inMemoryStore = new Map();
const activeJobs = new Map();

async function initPersistence() {
  try {
    mongoClient = new MongoClient(MONGO_URI, { useUnifiedTopology: true });
    await mongoClient.connect();
    const db = mongoClient.db(MONGO_DB_NAME);
    messagesCol = db.collection('cat_messages');
    await messagesCol.createIndex({ nextRunAt: 1 });
    console.log('Mongo connected');
    return 'mongo';
  } catch (e) {
    console.error('Mongo connection failed, using JSON fallback', e);
    if (fs.existsSync(SCHEDULE_JSON_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SCHEDULE_JSON_FILE, 'utf8'));
      for (const r of arr) inMemoryStore.set(r.id, r);
    }
    return 'json';
  }
}

async function persistSaveMessage(msg) {
  msg.updatedAt = new Date().toISOString();
  if (!msg.createdAt) msg.createdAt = msg.updatedAt;
  if (messagesCol) {
    await messagesCol.updateOne({ id: msg.id }, { $set: msg }, { upsert: true });
  } else {
    inMemoryStore.set(msg.id, msg);
    fs.writeFileSync(SCHEDULE_JSON_FILE, JSON.stringify(Array.from(inMemoryStore.values()), null, 2));
  }
}

async function persistDeleteMessage(id) {
  if (messagesCol) await messagesCol.deleteOne({ id });
  else {
    inMemoryStore.delete(id);
    fs.writeFileSync(SCHEDULE_JSON_FILE, JSON.stringify(Array.from(inMemoryStore.values()), null, 2));
  }
}

async function persistGetMessage(id) {
  if (messagesCol) return await messagesCol.findOne({ id });
  else return inMemoryStore.get(id) || null;
}

async function persistListMessagesByUser(userId) {
  if (messagesCol) return await messagesCol.find({ userId }).sort({ nextRunAt: 1 }).toArray();
  else return Array.from(inMemoryStore.values()).filter(m => m.userId===userId).sort((a,b)=>(a.nextRunAt||'')>(b.nextRunAt||'')?1:-1);
}

async function persistListAllActive() {
  if (messagesCol) return await messagesCol.find({ status:'active' }).toArray();
  else return Array.from(inMemoryStore.values()).filter(m => m.status==='active');
}

const utils = {
  genId: (prefix='m_') => `${prefix}${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
  todayISO: () => new Date().toISOString().split('T')[0],
  cat: () => Math.random()<0.3?['₍^. .^₎⟆','ᓚ₍ ^. .^₎','ฅ^•ﻌ•^ฅ'][Math.floor(Math.random()*3)]:'',
};

async function performSend(msg) {
  try {
    if (!msg.channel) throw new Error('No channel');
    const text = (msg.title?`*${msg.title}*\n`:'')+(msg.message||'')+utils.cat();
    const res = await app.client.chat.postMessage({ channel: msg.channel, text });
    if (!res.ok) throw new Error('Slack error');
    msg.lastSentAt = new Date().toISOString();
    await persistSaveMessage(msg);
  } catch(e){
    console.error('Send error', e);
    msg.status='failed'; msg.lastError=e.message||String(e);
    await persistSaveMessage(msg);
  }
}

async function scheduleJobForMessage(msg){
  if(activeJobs.has(msg.id)){const j=activeJobs.get(msg.id);j.cancel?.();activeJobs.delete(msg.id);}
  if(!msg||msg.status!=='active')return;
  if(msg.scheduleType==='recurring'&&msg.cron){
    const job=cron.schedule(msg.cron,async()=>{await performSend(msg);});
    activeJobs.set(msg.id,{type:'cron',job}); return;
  }
  let when=msg.nextRunAt?new Date(msg.nextRunAt):msg.date&&msg.time?new Date(`${msg.date}T${msg.time}:00`):null;
  if(!when||isNaN(when.getTime())){msg.status='failed';await persistSaveMessage(msg);return;}
  if(when<=new Date()){msg.status='failed';await persistSaveMessage(msg);return;}
  const job=schedule.scheduleJob(when,async()=>{await performSend(msg);msg.status='done';await persistSaveMessage(msg);activeJobs.delete(msg.id);});
  activeJobs.set(msg.id,{type:'onetime',job});
}

async function rescheduleAllActive(){
  const active=await persistListAllActive();
  for(const m of active) await scheduleJobForMessage(m);
}

// Minimal UI: main menu for demonstration
app.command('/cat', async ({ ack, body, client })=>{
  await ack();
  await client.chat.postEphemeral({channel:body.user_id,user:body.user_id,text:'Cat Scheduler Bot is running!'});
});

(async function boot(){
  const mode=await initPersistence();
  await rescheduleAllActive();
  await app.start(PORT);
  console.log(`Cat bot started on port ${PORT} (persistence=${mode})`);
})();
