import React, { useState, useEffect, useCallback } from "react";

// ═══════════════════════════════════════════════════════
// CLOUD STORAGE (persistent across devices via claude.ai)
// ═══════════════════════════════════════════════════════
const CLOUD_KEY  = "tane_money_v9";
const LOCAL_KEY  = "tane_money_v9_local";
const LOCAL_KEY2 = "tane_money_v9_backup";
const FAMILY_CODE_KEY = "tane_money_family_code";

// window.storageが使えるか確認
const hasCloudStorage = () => {
  try { return !!(window.storage && typeof window.storage.get === "function"); }
  catch(e) { return false; }
};

// Firebase config
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCrwnL1XisVygG11z5CLq4FTPXIanZqT8E",
  authDomain: "tane-money.firebaseapp.com",
  projectId: "tane-money",
  storageBucket: "tane-money.firebasestorage.app",
  messagingSenderId: "168102674534",
  appId: "1:168102674534:web:691b66d776ed0d60b5ada7"
};
let _db=null,_fbInit=false,_saveTimer=null,_pendingSave=null,_unsubscribe=null,_lastSyncTime=null;
let _familyCode=null; // ファミリーコードのキャッシュ

function getDB(){
  if(_db)return _db;
  try{
    if(!_fbInit){try{firebase.app();}catch(e){firebase.initializeApp(FIREBASE_CONFIG);}_fbInit=true;}
    _db=firebase.firestore();return _db;
  }catch(e){return null;}
}

function getFamilyCode(){
  if(_familyCode)return _familyCode;
  try{_familyCode=localStorage.getItem(FAMILY_CODE_KEY);}catch(e){}
  return _familyCode;
}

async function cloudSave(d) {
  const code = getFamilyCode()||"default";
  const json = JSON.stringify(d);
  // 1. コード固有のローカルストレージ（即時・他コードと分離）
  try { localStorage.setItem(LOCAL_KEY+"_"+code, json); } catch(e) {}
  try { localStorage.setItem(LOCAL_KEY2+"_"+code, json); } catch(e) {}
  // 2. Firestore（デバウンス2秒・家族間リアルタイム同期）
  _pendingSave = json;
  if(_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async()=>{
    if(!code||code==="default")return;
    const db = getDB();
    if(!db)return;
    try{
      const ts = new Date().toISOString();
      _lastSyncTime = ts;
      await db.collection("families").doc(code).set({data:_pendingSave,updatedAt:ts});
    }catch(e){console.warn("Firestore save failed:",e);}
  },1000); // 1秒デバウンス（目標・設定変更が素早く保存される）
  // 3. Claude.ai内ならwindow.storageにも保存
  if (hasCloudStorage()) {
    try { await window.storage.set(CLOUD_KEY, json); } catch(e) {}
  }
}

async function cloudLoad() {
  const code = getFamilyCode();
  // 1. Firestoreから読む（最優先・他デバイスと同期）
  if(code){
    const db=getDB();
    if(db){
      try{
        const doc=await db.collection("families").doc(code).get();
        if(doc.exists&&doc.data()&&doc.data().data){
          const parsed=JSON.parse(doc.data().data);
          if(parsed&&parsed.children&&parsed.children.length>0){
            try{localStorage.setItem(LOCAL_KEY+"_"+code,doc.data().data);}catch(e){}
            console.log("Loaded from Firestore:",code);
            return parsed;
          }
        }
      }catch(e){console.warn("Firestore load failed:",e);}
    }
  }
  // 2. コード固有のローカルストレージ
  if(code){
    try{
      const local=localStorage.getItem(LOCAL_KEY+"_"+code);
      if(local){const p=JSON.parse(local);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
    try{
      const local2=localStorage.getItem(LOCAL_KEY2+"_"+code);
      if(local2){const p=JSON.parse(local2);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
  }
  // 3. 後方互換（TANE-YUTAまたは既存データの移行）
  if(!code||code==="TANE-YUTA"){
    try{
      const old=localStorage.getItem(LOCAL_KEY);
      if(old){const p=JSON.parse(old);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
  }
  // 4. 新規コード → nullを返してINITから始める
  return null;
}

// リアルタイム同期（他デバイスの変更を即反映）
function startRealtimeSync(updateFn){
  const code=getFamilyCode();
  if(!code||code==="default")return;
  const db=getDB();
  if(!db)return;
  if(_unsubscribe)_unsubscribe();
  try{
    _unsubscribe=db.collection("families").doc(code).onSnapshot(doc=>{
      if(!doc.exists||!doc.data()||!doc.data().data)return;
      const t=doc.data().updatedAt||"";
      if(_lastSyncTime===t)return; // 自分の保存は無視
      _lastSyncTime=t;
      try{
        const parsed=JSON.parse(doc.data().data);
        if(parsed&&parsed.children&&parsed.children.length>0){
          try{localStorage.setItem(LOCAL_KEY+"_"+code,doc.data().data);}catch(e){}
          updateFn(prev=>{
            // マージルール：設定系はFirestore反映、ユーザーデータはローカル優先
            const merged=migrate(parsed);
            if(!prev) return merged;
            // ローカル優先（ユーザーが直接編集するデータ）
            if(prev.goals&&prev.goals.length>0) merged.goals=prev.goals;
            if(prev.holdings&&Object.keys(prev.holdings).length>0) merged.holdings=prev.holdings;
            if(prev.forexHoldings&&Object.keys(prev.forexHoldings).length>0) merged.forexHoldings=prev.forexHoldings;
            if(prev.expenses&&prev.expenses.length>0) merged.expenses=prev.expenses;
            if(prev.claimedBadges) merged.claimedBadges=prev.claimedBadges;
            if(prev.noPinIds) merged.noPinIds=prev.noPinIds;
            merged.logs=prev.logs; // logsはlogsリアルタイム同期で別管理
            // リアルタイム取得系（ローカル優先）
            if(prev.stocks&&prev.stocks.length>0) merged.stocks=prev.stocks;
            if(prev.forex&&Object.keys(prev.forex).length>0) merged.forex=prev.forex;
            // ゲーム進行系（ローカル優先）
            // ※ gachaDateをここで守らないとFirestoreの遅延snaphotで1日1回制限が崩れる
            if(prev.gachaDate){merged.gachaDate={...(merged.gachaDate||{})};const _td=todayKey();Object.keys(prev.gachaDate).forEach(cid=>{if(prev.gachaDate[cid]===_td)merged.gachaDate[cid]=_td;});}
            if(prev.streak) merged.streak=prev.streak;
            if(prev.dailyProgress) merged.dailyProgress=prev.dailyProgress;
            return merged;
          });
          console.log("Realtime sync:",t);
        }
      }catch(e){}
    },err=>console.warn("Realtime sync error:",err));
    console.log("Realtime sync started:",code);
  }catch(e){console.warn("Could not start realtime sync:",e);}
}

// ── ログ1件をFirestoreに直接追記（上書きなし・衝突なし）──
async function addLogToFirestore(logEntry) {
  const code = getFamilyCode();
  if(!code || code==="default") return;
  const db = getDB();
  if(!db) return;
  try {
    const docId = `log_${logEntry.cid}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    await db.collection("families").doc(code)
            .collection("logs").doc(docId).set({
      ...logEntry,
      id: logEntry.id || docId,
      savedAt: new Date().toISOString()
    });
  } catch(e) { console.warn("Firestore log write failed:", e); }
}

// ── Firestoreのlogsコレクションを全件読み込む ──
async function loadLogsFromFirestore() {
  const code = getFamilyCode();
  if(!code || code==="default") return null;
  const db = getDB();
  if(!db) return null;
  try {
    const snap = await db.collection("families").doc(code)
                         .collection("logs").orderBy("date","desc").limit(500).get();
    if(snap.empty) return null;
    return snap.docs.map(d => d.data());
  } catch(e) {
    console.warn("Firestore logs load failed:", e);
    return null;
  }
}

// ── logsコレクションのリアルタイム監視 ──
let _logsUnsubscribe = null;
function startLogsRealtimeSync(updateFn) {
  const code = getFamilyCode();
  if(!code || code==="default") return;
  const db = getDB();
  if(!db) return;
  if(_logsUnsubscribe) _logsUnsubscribe();
  try {
    // 直近24時間分のログをリアルタイム監視
    const since = new Date(Date.now() - 24*60*60*1000).toISOString();
    _logsUnsubscribe = db.collection("families").doc(code)
      .collection("logs")
      .where("date", ">=", since)
      .onSnapshot(snap => {
        if(snap.empty) return;
        const newLogs = snap.docs.map(d => d.data());
        updateFn(prev => {
          if(!prev) return prev;
          // 既存ログと新ログをマージ（重複排除・日付順）
          const existingIds = new Set((prev.logs||[]).map(l=>l.id));
          const added = newLogs.filter(l => !existingIds.has(l.id));
          if(added.length === 0) return prev;
          const merged = [...added, ...(prev.logs||[])];
          merged.sort((a,b) => new Date(b.date) - new Date(a.date));
          console.log(`Realtime: ${added.length}件の新ログを追加`);
          return {...prev, logs: merged};
        });
      }, err => console.warn("Logs realtime sync error:", err));
    console.log("Logs realtime sync started:", code);
  } catch(e) { console.warn("Could not start logs realtime sync:", e); }
}


// ═══════════════════════════════════════════════════════
const INIT = {
  parentPin: "0000",
  children: [
    { id: "c1", name: "れいか", emoji: "🌸", pin: "1111", ageMode: "middle",
      displayMode: "teen", role: "child", gradeLabel: "中学生",
      permissions: { investment: "trade", forex: "trade", dailyBonus: true, ranking: true },
      visibility: { balanceToFamily: "hidden", goalToFamily: "progress_only", investmentResultToFamily: "ranking_only", rankingParticipation: true, operationRankingParticipation: true, rankingMetric: "approved_activity_points" }
    },
    { id: "c2", name: "かなと", emoji: "⚡", pin: "2222", ageMode: "senior",
      displayMode: "teen", role: "child", gradeLabel: "高校生",
      permissions: { investment: "trade", forex: "trade", dailyBonus: true, ranking: true },
      visibility: { balanceToFamily: "hidden", goalToFamily: "progress_only", investmentResultToFamily: "ranking_only", rankingParticipation: true, operationRankingParticipation: true, rankingMetric: "approved_activity_points" }
    },
  ],
  goodTasks: [
    {id:"g01",emoji:"📝",label:"テスト点100点",pts:500,over:{}},
    {id:"g02",emoji:"🗑",label:"ゴミ袋大",pts:20,over:{}},
    {id:"g03",emoji:"🗑",label:"ゴミ袋小",pts:10,over:{}},
    {id:"g04",emoji:"🍚",label:"お米を炊く",pts:30,over:{}},
    {id:"g05",emoji:"👟",label:"玄関の靴を全てきれいに並べる",pts:10,over:{}},
    {id:"g06",emoji:"🤖",label:"ルンバのゴミを捨てる",pts:10,over:{}},
    {id:"g07",emoji:"💧",label:"水のボトルに水を入れる",pts:10,over:{}},
    {id:"g08",emoji:"🐱",label:"猫の汚物の掃除",pts:30,over:{}},
    {id:"g09",emoji:"🛁",label:"お風呂掃除をする",pts:20,over:{}},
    {id:"g10",emoji:"🐱",label:"猫の排泄物を掃除する",pts:50,over:{}},
    {id:"g11",emoji:"🚽",label:"猫のトイレ掃除を手伝う",pts:100,over:{}},
    {id:"g12",emoji:"🌙",label:"23時までに寝る",pts:20,over:{}},
    {id:"g13",emoji:"🌙",label:"22時までに寝る",pts:30,over:{}},
    {id:"g14",emoji:"👕",label:"自分の乾いた洗濯物を片付ける",pts:5,over:{}},
    {id:"g15",emoji:"⏰",label:"朝6時35分までに自分で起きる",pts:10,over:{}},
    {id:"g16",emoji:"🧹",label:"一部屋掃除機をかける",pts:50,over:{}},
    {id:"g17",emoji:"🍬",label:"お菓子コーナーの片付け(2週間に1回)",pts:100,over:{}},
    {id:"g18",emoji:"🛏",label:"朝10時までに布団を干す&回収する",pts:100,over:{}},
    {id:"g19",emoji:"📐",label:"自分の机の上・下の整理整頓",pts:50,over:{}},
    {id:"g20",emoji:"👔",label:"洗濯物を洗濯機から出す&干す",pts:50,over:{}},
    {id:"g21",emoji:"👚",label:"クローゼットの整理整頓",pts:50,over:{}},
    {id:"g22",emoji:"🛏",label:"じいちゃんの布団を直す",pts:30,over:{}},
    {id:"g23",emoji:"🛏",label:"じいちゃんの布団を出す",pts:30,over:{}},
    {id:"g24",emoji:"🍽",label:"食洗機に食器を入れて回す&片付け",pts:30,over:{}},
    {id:"g25",emoji:"🌀",label:"換気扇フィルターを変える",pts:30,over:{}},
    {id:"g26",emoji:"🗑",label:"ゴミの日にゴミを集める",pts:10,over:{}},
    {id:"g27",emoji:"🧻",label:"テーブルを拭く(制限時間3分)",pts:20,over:{}},
    {id:"g28",emoji:"🛏",label:"ベッドメイク",pts:5,over:{}},
    {id:"g29",emoji:"🧺",label:"1枚タオルを畳む&直す",pts:5,over:{}},
    {id:"g30",emoji:"👟",label:"シューズを持って帰ってくる",pts:5,over:{}},
    {id:"g31",emoji:"👕",label:"朝パジャマを片付ける",pts:5,over:{}},
    {id:"g32",emoji:"🪑",label:"テーブル周りに何も置かない",pts:10,over:{}},
    {id:"g33",emoji:"🗑",label:"ゴミ袋をゴミ箱にセットする",pts:5,over:{}},
    {id:"g34",emoji:"🗑",label:"落ちているゴミを2個捨てる",pts:5,over:{}},
    {id:"g35",emoji:"👶",label:"おむつを捨てる",pts:5,over:{}},
    {id:"g36",emoji:"📝",label:"県版テスト満点",pts:1000,over:{}},
  ],
  badTasks: [
    {id:"b01",emoji:"📺",label:"勝手にYouTubeを見る",pts:-50,over:{}},
    {id:"b02",emoji:"🍽",label:"積極的にご飯を準備しない",pts:-50,over:{}},
    {id:"b03",emoji:"🙈",label:"返事をしない",pts:-50,over:{}},
    {id:"b04",emoji:"🪑",label:"テーブル周りに自分のものを置きっぱなし",pts:-30,over:{}},
    {id:"b05",emoji:"🎒",label:"下校後に学校カバンを指定の場所にしまわない",pts:-10,over:{}},
    {id:"b06",emoji:"👟",label:"自分の靴が揃っていない",pts:-10,over:{}},
    {id:"b07",emoji:"👔",label:"下校後すぐに制服をハンガーにかけない",pts:-10,over:{}},
    {id:"b08",emoji:"👕",label:"服・パジャマの置きっぱなし",pts:-20,over:{}},
    {id:"b09",emoji:"😮",label:"口を5回開ける",pts:-500,over:{}},
    {id:"b10",emoji:"🤥",label:"嘘をつく",pts:-500,over:{}},
    {id:"b11",emoji:"📚",label:"勉強机の周りに不要なものが落ちている",pts:-200,over:{}},
  ],
  rewards: [
    {id:"r01",emoji:"🎮",label:"スイッチオンライン代(毎月1日)",cost:200,unit:"毎月の支払いに充てる"},
    {id:"r02",emoji:"📱",label:"スマートフォン30分",cost:200,unit:"スマホ使用時間+30分"},
    {id:"r03",emoji:"🍬",label:"好きなお菓子いっこ",cost:200,unit:"好きなお菓子1つ"},
    {id:"r04",emoji:"🎬",label:"Netflix 30分",cost:200,unit:"Netflix視聴+30分"},
    {id:"r05",emoji:"📺",label:"YouTube 30分",cost:200,unit:"YouTube視聴+30分"},
    {id:"r06",emoji:"🎮",label:"ゲーム30分",cost:200,unit:"ゲーム時間+30分"},
    {id:"r07",emoji:"💴",label:"500円交換",cost:2000,unit:"現金500円と交換"},
  ],
  gacha: [
    { id: "gc1", emoji: "⚪", label: "ノーマル",     color: "#9a917a", rate: 60, min: 1,  max: 10  },
    { id: "gc2", emoji: "🔵", label: "レア",         color: "#4a9eff", rate: 25, min: 11, max: 25  },
    { id: "gc3", emoji: "🟡", label: "スーパーレア", color: "#f5c842", rate: 12, min: 26, max: 40  },
    { id: "gc4", emoji: "🔴", label: "激レア",       color: "#f0605a", rate: 3,  min: 41, max: 50  },
  ],
  cats: [
    { id: "cat1", emoji: "🍕", label: "食べもの",     color: "#f97316" },
    { id: "cat2", emoji: "🎮", label: "ゲーム・遊び", color: "#8b5cf6" },
    { id: "cat3", emoji: "📚", label: "本・文具",     color: "#3b82f6" },
    { id: "cat4", emoji: "👗", label: "服・グッズ",   color: "#ec4899" },
    { id: "cat5", emoji: "🎁", label: "プレゼント",   color: "#10b981" },
    { id: "cat6", emoji: "💡", label: "その他",       color: "#9a917a" },
  ],
  logs: [],      // {id,cid,type,label,pts,date,rid?}
  expenses: [],  // {id,cid,catId,label,amt,date}
  goals: [],     // {id,cid,emoji,label,target,done,doneDate?}
  gachaDate: {}, // {[cid]: "YYYY-M-D"}
  streak: {},    // {[cid]: {cur,max,last}}
  // daily tasks: checklist or count, reset each day
  dailyTasks: [
    { id: "d1", emoji: "🧹", label: "部屋の片付け",       type: "check", pts: 30, target: 1 },
    { id: "d2", emoji: "🍽", label: "皿洗い",            type: "count", pts: 20, target: 1 },
    { id: "d3", emoji: "📐", label: "机の上を片付ける",   type: "check", pts: 20, target: 1 },
  ],
  dailyBonus: 50,
  // 複数タスクセット管理
  dailyTaskSets: [
    {
      id: "set_default",
      name: "通常セット",
      emoji: "📋",
      tasks: [
        { id: "d1", emoji: "🧹", label: "部屋の片付け",     type: "check", pts: 30, target: 1 },
        { id: "d2", emoji: "🍽", label: "皿洗い",          type: "count", pts: 20, target: 1 },
        { id: "d3", emoji: "📐", label: "机の上を片付ける", type: "check", pts: 20, target: 1 },
      ],
      bonus: 50,
      startDate: "",   // "" = 常時有効
      endDate: "",
      active: true,
    }
  ],
  activeSetId: "set_default",  // 現在アクティブなセットID
  dailyProgress: {},
  parents: [
    {id:"p1",name:"パパ",emoji:"👨",pin:"3333",
      displayMode:"adult", role:"parent", gradeLabel:"",
      participationMode:"player_and_guardian",
      permissions:{investment:"trade",forex:"trade",dailyBonus:true,ranking:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"}
    },
    {id:"p2",name:"ママ",emoji:"👩",pin:"4444",
      displayMode:"adult", role:"parent", gradeLabel:"",
      participationMode:"player_and_guardian",
      permissions:{investment:"trade",forex:"trade",dailyBonus:true,ranking:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"}
    },
  ],
  parentLogs: {},
  parentTasks: [
    {id:"pt1",emoji:"🍳",label:"朝食を作る",pts:30},
    {id:"pt2",emoji:"🧹",label:"掃除機をかける",pts:40},
    {id:"pt3",emoji:"🛒",label:"買い物をする",pts:30},
  ],
  familyRewards: [
    {id:"fr1",emoji:"🍕",label:"家族でピザ",cost:500},
    {id:"fr2",emoji:"🎬",label:"映画を見る",cost:300},
  ],
  violations: [],
  tutorialSeen: {},
  pinChanged: {},
  lockEnabled: {},
  interestEnabled: true,
  interestRate: 0.05,
  interestLastDate: {},
  holdBonusLastDate: {},
  weeklyReportSeen: {},
  stocks: [
    {id:"s1",emoji:"🎮",name:"任天堂",ticker:"7974.T",sector:"ゲーム",price:8000,history:[8000],currency:"JPY"},
    {id:"s2",emoji:"🎵",name:"ソニー",ticker:"6758.T",sector:"エンタメ",price:2800,history:[2800],currency:"JPY"},
    {id:"s3",emoji:"🚗",name:"トヨタ",ticker:"7203.T",sector:"自動車",price:3000,history:[3000],currency:"JPY"},
    {id:"s4",emoji:"🍔",name:"マクドナルド",ticker:"MCD",sector:"食品",price:380,history:[380],currency:"USD"},
    {id:"s5",emoji:"🍎",name:"Apple",ticker:"AAPL",sector:"テクノロジー",price:220,history:[220],currency:"USD"},
  ],
  holdings: {},
  stockLastUpdate: "",
  stockFetchStatus: "idle",
  myTaskIds: {},
  tipsRead: {},
  childDailyBonus: {},
  parentMultiplier: 1.0,
  forexHoldings: {},  // {memberId: {USD:10, EUR:5, ...}}
  claimedBadges: {},  // {memberId: ["b01","b02",...]}
  noPinIds: {},       // {memberId: true} PINなし設定
  familySettings: {
    parentPointRule: "partner_approval",  // self_record_only | partner_approval | family_fixed_tasks | guardian_only
    rankingDefaultMetric: "approved_activity_points",
    enabledRankingMetrics: ["approved_activity_points","streak","learning_completed","goals_completed","operation_return_rate"],
    operationRanking: { enabled: true, defaultTab: "total", rankingBasis: "return_rate", includeFees: true, allowParents: true },
    familyMission: { enabled: true, label: "みんなの活動で 3,000 pt を育てよう", target: 3000, reward: "週末に家族でアイスを選ぶ" },
    requireApproval: false,
  },
  pendingApprovals: [],
};

function migrate(d) {
  if (!d) return {...INIT};
  if (!d.logs)         d.logs=[];
  if (!d.expenses)     d.expenses=[];
  if (!d.goals)        d.goals=[];
  if (!d.children||d.children.length===0) d.children=INIT.children;
  if (!d.cats)         d.cats=INIT.cats;
  if (!d.gachaDate)    d.gachaDate={};
  if (!d.streak)       d.streak={};
  if (!d.dailyTasks)   d.dailyTasks=INIT.dailyTasks;
  if(d.dailyBonus===undefined) d.dailyBonus=50;
  if(!d.forexHoldings) d.forexHoldings={};
  if(!d.claimedBadges) d.claimedBadges={};
  if(!d.noPinIds)      d.noPinIds={};
  if(!d.pendingApprovals) d.pendingApprovals=[];
  if(!d.familySettings) d.familySettings={...INIT.familySettings};
  if(d.familySettings.requireApproval===undefined) d.familySettings.requireApproval=false;
  if(!d.onboardingChecks) d.onboardingChecks={};
  if(!d.gachaCollection) d.gachaCollection={};
  // 既存メンバーにdisplayMode・permissions・visibilityを後付け（後方互換）
  const defaultChildPerms={investment:"trade",forex:"trade",dailyBonus:true,ranking:true};
  const defaultChildVis={balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"};
  const defaultParentPerms={investment:"trade",forex:"trade",dailyBonus:true,ranking:true};
  const defaultParentVis={balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"};
  d.children=d.children.map(c=>({displayMode:"teen",role:"child",gradeLabel:"",permissions:defaultChildPerms,visibility:defaultChildVis,...c}));
  if(d.parents) d.parents=d.parents.map(p=>({displayMode:"adult",role:"parent",gradeLabel:"",participationMode:"player_and_guardian",permissions:defaultParentPerms,visibility:defaultParentVis,...p}));
  // dailyTaskSetsがなければdailyTasksから自動生成
  if(!d.dailyTaskSets||d.dailyTaskSets.length===0){
    d.dailyTaskSets=[{
      id:"set_default",name:"通常セット",emoji:"📋",
      tasks:(d.dailyTasks||[]).map(t=>({...t})),
      bonus:d.dailyBonus||50,
      startDate:"",endDate:"",active:true
    }];
    d.activeSetId="set_default";
  }
  // 各セットのtasksがarrayでない場合を修正
  d.dailyTaskSets=d.dailyTaskSets.map(s=>({
    ...s,
    tasks:Array.isArray(s.tasks)?s.tasks:[],
    bonus:s.bonus??50,
    active:s.active!==false,
  }));
  if(!d.activeSetId) d.activeSetId=d.dailyTaskSets[0]?.id||"set_default";
  if(!d.dailyProgress) d.dailyProgress={};
  if(!d.rewards||d.rewards.length===0) d.rewards=INIT.rewards;
  if(d.rewards.length<=3&&d.rewards.some(r=>r.id==="r1"||r.id==="r2")) d.rewards=INIT.rewards;
  if(!d.gacha||d.gacha.length===0) d.gacha=INIT.gacha;
  if(!d.parentTasks)   d.parentTasks=INIT.parentTasks;
  if(!d.familyRewards) d.familyRewards=INIT.familyRewards;
  if(!d.parentLogs)    d.parentLogs={};
  if(!d.violations)    d.violations=[];
  if(!d.tutorialSeen)  d.tutorialSeen={};
  if(!d.pinChanged)    d.pinChanged={};
  if(!d.lockEnabled)   d.lockEnabled={};
  if(!d.parents)       d.parents=INIT.parents;
  if(d.parentMultiplier===undefined) d.parentMultiplier=1.0;
  if(d.interestRate===undefined)     d.interestRate=0.05;
  if(d.interestEnabled===undefined)  d.interestEnabled=true;
  if(!d.interestLastDate)            d.interestLastDate={};
  if(!d.holdBonusLastDate)           d.holdBonusLastDate={};
  if(!d.weeklyReportSeen)            d.weeklyReportSeen={};
  if(!d.stocks||d.stocks.length===0) d.stocks=INIT.stocks;
  if(d.stocks&&d.stocks[0]&&!d.stocks[0].ticker) d.stocks=INIT.stocks;
  if(!d.forex||Object.keys(d.forex).length===0) d.forex={
    "USDJPY=X":{code:"USD",flag:"🇺🇸",name:"アメリカ ドル",price:155,prev:155,history:[152,153,154,155,155],changePct:0,realData:false},
    "EURJPY=X":{code:"EUR",flag:"🇪🇺",name:"ユーロ",price:168,prev:168,history:[165,166,167,168,168],changePct:0,realData:false},
    "GBPJPY=X":{code:"GBP",flag:"🇬🇧",name:"イギリス ポンド",price:196,prev:196,history:[193,194,195,196,196],changePct:0,realData:false},
    "CNYJPY=X":{code:"CNY",flag:"🇨🇳",name:"中国 人民元",price:21.4,prev:21.4,history:[21.0,21.1,21.2,21.4,21.4],changePct:0,realData:false},
    "KRWJPY=X":{code:"KRW",flag:"🇰🇷",name:"韓国 ウォン",price:0.112,prev:0.112,history:[0.110,0.111,0.112,0.112,0.112],changePct:0,realData:false},
  };
  if(!d.holdings)      d.holdings={};
  if(!d.stockLastUpdate) d.stockLastUpdate="";
  if(!d.stockFetchStatus) d.stockFetchStatus="idle";
  if(!d.myTaskIds)     d.myTaskIds={};
  if(!d.tipsRead)      d.tipsRead={};
  if(!d.childDailyBonus) d.childDailyBonus={};
  if(Array.isArray(d.parentLogs)){
    const obj={};
    (d.parents||[]).forEach(p=>{obj[p.id]=[];});
    d.parentLogs=obj;
  }
  if(!d.parentLogs||typeof d.parentLogs!=="object") d.parentLogs={};
  d.goodTasks=(d.goodTasks||[]).map(t=>({...t,over:t.over||t.overrides||{}}));
  d.badTasks =(d.badTasks||[]).map(t=>({...t,over:t.over||t.overrides||{}}));
  d.children =(d.children||[]).map(c=>({...c,ageMode:c.ageMode||"middle"}));
  if(d.goodTasks.length<=4&&d.goodTasks.some(t=>t.id==="g1"||t.id==="g2")) d.goodTasks=INIT.goodTasks;
  if(d.badTasks.length<=3&&d.badTasks.some(t=>t.id==="b1"||t.id==="b2"))   d.badTasks=INIT.badTasks;
  if(!d.tutorialSeen||Object.keys(d.tutorialSeen).length===0){
    if((d.logs||[]).length>0){
      const seen={"parent":true};
      (d.children||[]).forEach(c=>{seen[c.id]=true;});
      (d.parents||[]).forEach(p=>{seen[p.id]=true;});
      d.tutorialSeen=seen;
    }
  }
  if(!d.pinChanged&&(d.logs||[]).length>0){
    const changed={};
    (d.children||[]).forEach(c=>{changed[c.id]=true;});
    d.pinChanged=changed;
  }
  return d;
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
const todayKey = () => { const d=new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; };

// ── 運用損益計算ヘルパー ──────────────────────────────
// 手数料込みの実質損益率を計算
const calcReturnRate = (totalCost, currentNetValue) => {
  if(!totalCost || totalCost<=0) return null;
  return ((currentNetValue - totalCost) / totalCost) * 100;
};

// メンバーの運用成績を計算（株・為替・総合）
const calcMemberOperation = (memberId, data, type="total") => {
  const logs = (data.logs||[]).filter(l=>l.cid===memberId);
  // 株式の損益計算
  const stockBuyCost = logs.filter(l=>l.type==="invest_buy").reduce((s,l)=>s+Math.abs(l.pts),0);
  const stockSellEarn = logs.filter(l=>l.type==="invest_sell").reduce((s,l)=>s+l.pts,0);
  const holdings = (data.holdings||{})[memberId]||[];
  const stocks = data.stocks||[];
  const stockCurrentValue = holdings.reduce((s,h)=>{
    const st=stocks.find(x=>x.id===h.stockId);
    if(!st)return s;
    const price=st.price;
    const currency=st.currency;
    const pts=currency==="JPY"?Math.round(price*h.qty):Math.round(price*h.qty*10);
    return s + Math.floor(pts*0.9); // 売却時10%手数料を考慮
  },0);
  // 為替の損益計算
  const forexBuyCost = logs.filter(l=>l.type==="forex_buy").reduce((s,l)=>s+Math.abs(l.pts),0);
  const forexSellEarn = logs.filter(l=>l.type==="forex_sell").reduce((s,l)=>s+l.pts,0);
  const forexHeld = (data.forexHoldings||{})[memberId]||{};
  const forexData = data.forex||{};
  const forexCurrentValue = Object.entries(forexHeld).reduce((s,[code,amt])=>{
    const fxEntry = Object.values(forexData).find(f=>f.code===code);
    if(!fxEntry||!amt)return s;
    return s + Math.floor(amt*(fxEntry.price||0)*0.98); // 売却時2%手数料
  },0);

  const stockNetCost = stockBuyCost - stockSellEarn;
  const stockNetValue = stockCurrentValue + stockSellEarn;
  const forexNetCost = forexBuyCost - forexSellEarn;
  const forexNetValue = forexCurrentValue + forexSellEarn;

  if(type==="stocks") {
    if(stockBuyCost===0) return null;
    const rate=calcReturnRate(stockBuyCost, stockCurrentValue+stockSellEarn);
    return{cost:stockBuyCost, net:Math.round(stockCurrentValue+stockSellEarn), rate, pt:Math.round(stockCurrentValue+stockSellEarn-stockBuyCost)};
  }
  if(type==="forex") {
    if(forexBuyCost===0) return null;
    const rate=calcReturnRate(forexBuyCost, forexCurrentValue+forexSellEarn);
    return{cost:forexBuyCost, net:Math.round(forexCurrentValue+forexSellEarn), rate, pt:Math.round(forexCurrentValue+forexSellEarn-forexBuyCost)};
  }
  // total
  const totalCost = stockBuyCost + forexBuyCost;
  if(totalCost===0) return null;
  const totalNet = stockCurrentValue+stockSellEarn+forexCurrentValue+forexSellEarn;
  const rate=calcReturnRate(totalCost, totalNet);
  return{cost:totalCost, net:Math.round(totalNet), rate, pt:Math.round(totalNet-totalCost)};
};

// 今月の承認済み活動ptを計算（投資・為替除外）
const ACTIVITY_TYPES = ["good","bad","daily"];
const calcMonthlyActivity = (memberId, logs) => {
  const thisMonth = new Date().toISOString().slice(0,7);
  return (logs||[])
    .filter(l=>l.cid===memberId && ACTIVITY_TYPES.includes(l.type) && (l.date||"").startsWith(thisMonth))
    .reduce((s,l)=>s+(l.pts>0?l.pts:0),0);
};
const monthKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
const fmtDate  = iso => { const d=new Date(iso); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`; };
const uid      = () => Math.random().toString(36).slice(2,10);
const bal      = (logs, cid) => (logs||[]).filter(l=>l.cid===cid).reduce((s,l)=>s+l.pts,0);
const parentBal= (pLogs, pid) => ((pLogs||{})[pid]||[]).reduce((s,l)=>s+(l.pts||0),0);
const weekKey  = (d=new Date())=>{const jan1=new Date(d.getFullYear(),0,1);const w=Math.ceil((((d-jan1)/86400000)+jan1.getDay()+1)/7);return `${d.getFullYear()}-${String(w).padStart(2,"0")}`;};
const taskPts  = (task, cid) => task.over?.[cid] ?? task.pts;

function rollGacha(gacha) {
  const total = gacha.reduce((s,g)=>s+g.rate,0);
  let r = Math.random()*total;
  for (const g of gacha) { r-=g.rate; if(r<=0){ const pts=Math.floor(Math.random()*(g.max-g.min+1))+g.min; return {...g,pts}; } }
  return {...gacha[0], pts: gacha[0].min};
}

// ═══════════════════════════════════════════════════════
// DESIGN SYSTEM v2 — Tane Money
// ═══════════════════════════════════════════════════════
const BG    = "#F7F5EF";
const BG2   = "#FCFBF8";
const CARD  = "#FFFFFF";
const CARDS = "#F2EFE7";
const GP    = "#187A4E";   // green-primary
const G     = "#34C77B";   // green-bright（CTA）
const GS    = "#DDF3E7";   // green-soft
const GOLD  = "#E8B83E";   // gold
const GOLDS = "#FFF1CB";
const R     = "#D95C55";   // red
const RS    = "#FCE6E4";
const B     = "#3478D4";   // blue
const BS    = "#E5F0FF";
const P     = "#7B61C9";
const PS    = "#EFEAFE";
const TEXT  = "#18231D";
const TEXTS = "#59645E";
const MUTED = "#929B95";
const BORDER= "#E8E3D8";
const Y     = GOLD;        // 後方互換
const SHADOW = "0 4px 16px rgba(24,35,29,0.05)";
const F  = "'Noto Sans JP','M PLUS Rounded 1c','Hiragino Maru Gothic ProN',sans-serif";
const FB = "'M PLUS Rounded 1c','Hiragino Maru Gothic ProN',sans-serif";
const AGE={young:{label:"低学年",emoji:"🌱"},middle:{label:"中学年",emoji:"🌿"},senior:{label:"中高生",emoji:"🌳"}};
const INP = { fontFamily:F, padding:"9px 11px", borderRadius:10, border:`1.5px solid ${BORDER}`, fontSize:14, background:BG2, color:TEXT, width:"100%", boxSizing:"border-box" };

// ═══════════════════════════════════════════════════════
// TINY COMPONENTS
// ═══════════════════════════════════════════════════════
const Pt = ({v,sz=14}) => (
  <span style={{color:v>=0?G:R, fontWeight:800, fontSize:sz, display:"inline-flex", alignItems:"center", gap:1}}>
    {v>=0?"+":""}{v.toLocaleString()}<span style={{fontSize:sz-2}}>pt</span>
  </span>
);
const Yen = Pt;

const Btn = ({c,label,onClick,disabled,full,sm}) => (
  <button onClick={onClick} disabled={!!disabled}
    style={{background:disabled?BORDER:c, border:"none", borderRadius:8,
      padding:sm?"4px 8px":"7px 13px", color:"#fff", fontWeight:700,
      fontSize:sm?11:12, cursor:disabled?"default":"pointer", fontFamily:F,
      width:full?"100%":undefined, opacity:disabled?0.6:1}}>
    {label}
  </button>
);

const SyncBadge = ({status}) => {
  const map = { saving:"💾 同期中…", saved:"☁ 同期済み", error:"⚠ オフライン" };
  const col  = { saving:B, saved:G, error:R };
  const code = (()=>{try{return localStorage.getItem("tane_money_family_code")||"NO_CODE";}catch(e){return "ERR";}})();
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
      <span style={{fontSize:10, color:col[status]||MUTED, fontWeight:700, background:`${col[status]||MUTED}15`, padding:"2px 7px", borderRadius:10}}>{map[status]||status}</span>
      <span style={{fontSize:9, color:MUTED, fontWeight:700, padding:"1px 5px"}}>{code}</span>
    </div>
  );
};

// ═══════════════════════════════════════════════════════
// PIN PAD
// ═══════════════════════════════════════════════════════
function PinPad({ title, emoji, hint, check, onOk, onBack, extra }) {
  const [val, setVal] = useState("");
  const [shake, setShake] = useState(false);

  const press = k => {
    if (val.length >= 4) return;
    const nxt = val + k;
    setVal(nxt);
    if (nxt.length === 4) {
      if (check(nxt)) { onOk(); }
      else { setShake(true); setTimeout(()=>{ setVal(""); setShake(false); }, 600); }
    }
  };

  return (
    <div style={{minHeight:"100vh",background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:F,padding:24,position:"relative"}}>
      <button onClick={onBack} style={{position:"absolute",top:20,left:20,background:"none",border:"none",fontSize:28,cursor:"pointer",color:MUTED}}>‹</button>
      <div style={{fontSize:52,marginBottom:6}}>{emoji}</div>
      <h2 style={{color:TEXT,fontSize:20,fontWeight:800,margin:"0 0 4px"}}>{title}</h2>
      {hint && <p style={{color:MUTED,fontSize:11,margin:"0 0 20px",textAlign:"center",maxWidth:260}}>{hint}</p>}
      <div style={{display:"flex",gap:14,marginBottom:28,animation:shake?"shk .5s":undefined}}>
        {[0,1,2,3].map(i=>(
          <div key={i} style={{width:15,height:15,borderRadius:"50%",background:val.length>i?Y:"transparent",border:`2.5px solid ${shake?R:Y}`,transition:"background .15s"}}/>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,70px)",gap:10}}>
        {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
          <button key={i}
            onClick={()=>{ if(k==="⌫") setVal(v=>v.slice(0,-1)); else if(k!=="") press(String(k)); }}
            style={{width:70,height:70,borderRadius:18,background:k===""?"transparent":CARD,border:k===""?"none":`2px solid ${BORDER}`,fontSize:22,fontWeight:700,color:TEXT,cursor:k===""?"default":"pointer",fontFamily:F}}>
            {k}
          </button>
        ))}
      </div>
      {extra && <div style={{marginTop:20}}>{extra}</div>}
      <style>{`@keyframes shk{0%,100%{transform:translateX(0)}25%,75%{transform:translateX(-8px)}50%{transform:translateX(8px)}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// PIE CHART
// ═══════════════════════════════════════════════════════
function Pie({ data, size=140 }) {
  if (!data||!data.length) return <div style={{width:size,height:size,borderRadius:"50%",background:BORDER,display:"flex",alignItems:"center",justifyContent:"center",color:MUTED,fontSize:11}}>データなし</div>;
  const total = data.reduce((s,d)=>s+d.v,0);
  let a = -Math.PI/2;
  const cx=size/2, cy=size/2, r=size/2-4;
  return (
    <svg width={size} height={size}>
      {data.map((d,i)=>{
        const pct=d.v/total, s=a; a+=pct*2*Math.PI;
        const x1=cx+r*Math.cos(s),y1=cy+r*Math.sin(s),x2=cx+r*Math.cos(a),y2=cy+r*Math.sin(a);
        return <path key={i} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${pct>.5?1:0} 1 ${x2},${y2} Z`} fill={d.color} stroke="#fff" strokeWidth={2}/>;
      })}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════
// GACHA — 月テーマ定義
// ═══════════════════════════════════════════════════════
const GACHA_THEMES = [
  {name:"お正月",  emoji:"🎍", color:"#D95C55", bg:"#FCE6E4"},
  {name:"バレンタイン",emoji:"💝",color:"#ec4899",bg:"#fce7f3"},
  {name:"はる",   emoji:"🌸", color:"#e879a0", bg:"#fce7f3"},
  {name:"はな",   emoji:"🌺", color:"#f97316", bg:"#ffedd5"},
  {name:"こどもの日",emoji:"🎏",color:"#3478D4", bg:"#E5F0FF"},
  {name:"あめ",   emoji:"☔", color:"#3478D4", bg:"#E5F0FF"},
  {name:"なつ",   emoji:"🌊", color:"#06b6d4", bg:"#cffafe"},
  {name:"なつまつり",emoji:"🎆",color:"#f97316",bg:"#ffedd5"},
  {name:"つき",   emoji:"🌕", color:"#E8B83E", bg:"#FFF1CB"},
  {name:"ハロウィン",emoji:"🎃",color:"#f97316",bg:"#ffedd5"},
  {name:"あき",   emoji:"🍂", color:"#E8B83E", bg:"#FFF1CB"},
  {name:"クリスマス",emoji:"🎄",color:"#34C77B",bg:"#DDF3E7"},
];
function getMonthTheme(){ return GACHA_THEMES[new Date().getMonth()]; }

const GACHA_ITEMS = [
  {id:"gi_n1",tierId:"gc1",emoji:"🌱",name:"タネっち",  desc:"まいにちのタネ"},
  {id:"gi_n2",tierId:"gc1",emoji:"🌿",name:"わかば",    desc:"みどりのわかば"},
  {id:"gi_n3",tierId:"gc1",emoji:"🍀",name:"よつば",    desc:"しあわせのよつば"},
  {id:"gi_n4",tierId:"gc1",emoji:"🌾",name:"こむぎ",    desc:"ゆたかなみのり"},
  {id:"gi_n5",tierId:"gc1",emoji:"🍂",name:"おちば",    desc:"あきのきおく"},
  {id:"gi_n6",tierId:"gc1",emoji:"🌻",name:"ひまわり",  desc:"たいようのちから"},
  {id:"gi_r1",tierId:"gc2",emoji:"⭐",name:"スター",     desc:"かがやくほし"},
  {id:"gi_r2",tierId:"gc2",emoji:"🦋",name:"ちょうちょ",desc:"はねのかがやき"},
  {id:"gi_r3",tierId:"gc2",emoji:"🐠",name:"さかな",    desc:"うみのたから"},
  {id:"gi_r4",tierId:"gc2",emoji:"🌙",name:"みかづき",  desc:"よるのひかり"},
  {id:"gi_r5",tierId:"gc2",emoji:"🎵",name:"おんぷ",    desc:"こころのメロディ"},
  {id:"gi_r6",tierId:"gc2",emoji:"🔮",name:"まほうだま",desc:"ふしぎなちから"},
  {id:"gi_sr1",tierId:"gc3",emoji:"🌈",name:"にじ",     desc:"そらにかかるにじ"},
  {id:"gi_sr2",tierId:"gc3",emoji:"💎",name:"ダイヤ",   desc:"しんぴのほうせき"},
  {id:"gi_sr3",tierId:"gc3",emoji:"🦄",name:"ユニコーン",desc:"まほうのいきもの"},
  {id:"gi_sr4",tierId:"gc3",emoji:"🐉",name:"ドラゴン", desc:"でんせつのりゅう"},
  {id:"gi_ur1",tierId:"gc4",emoji:"👑",name:"おうかん",  desc:"さいこうのしるし"},
  {id:"gi_ur2",tierId:"gc4",emoji:"🌟",name:"ゴールドスター",desc:"きょくちょうのかがやき"},
];

// ═══════════════════════════════════════════════════════
// GACHA ANIMATION
// ═══════════════════════════════════════════════════════
function GachaAnim({ result, onClose }) {
  const [phase, setPhase] = useState("spin");
  const theme = result.theme || getMonthTheme();
  const isSuper = result.rate <= 3;
  const isSR    = result.rate <= 12;
  const hasSuspense = isSR; // SR以上はタメ演出

  useEffect(()=>{
    const spinMs = 1100;
    const suspenseMs = isSuper ? 2200 : 1400;
    if(hasSuspense){
      const t1=setTimeout(()=>{
        setPhase("suspense");
        try{
          if(isSuper) navigator.vibrate([150,80,150,80,300,80,500]);
          else        navigator.vibrate([100,60,180]);
        }catch(e){}
      }, spinMs);
      const t2=setTimeout(()=>setPhase("show"), spinMs+suspenseMs);
      return()=>{clearTimeout(t1);clearTimeout(t2);};
    } else {
      const t=setTimeout(()=>setPhase("show"), spinMs);
      return()=>clearTimeout(t);
    }
  },[]);

  const starCount = isSuper ? 30 : isSR ? 15 : 0;
  return (
    <div style={{position:"fixed",inset:0,background:"#000e",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      {phase==="spin"&&(
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:18,color:"rgba(255,255,255,0.6)",marginBottom:8,letterSpacing:1}}>{theme.emoji} {theme.name}ガチャ</div>
          <div style={{fontSize:80,animation:"sp .4s linear infinite"}}>🎰</div>
          <p style={{color:"#fff",fontWeight:800,fontSize:18,marginTop:12}}>ガチャ中…</p>
        </div>
      )}
      {phase==="suspense"&&(
        <div style={{textAlign:"center"}}>
          <div style={{
            width:130,height:130,borderRadius:"50%",margin:"0 auto",
            background:`radial-gradient(circle at 40% 35%,${result.color}ff,${result.color}88)`,
            animation:"heartbeat .65s ease-in-out infinite",
            boxShadow:`0 0 0 20px ${result.color}22,0 0 60px ${result.color}66`,
          }}/>
          <div style={{color:"rgba(255,255,255,0.85)",fontSize:isSuper?24:18,fontWeight:900,marginTop:22,animation:"fadePulse .65s ease-in-out infinite"}}>
            {isSuper?"‼ もしかして…":"あれ…？"}
          </div>
          {isSuper&&<div style={{color:result.color,fontSize:13,fontWeight:700,marginTop:8,animation:"fadePulse .65s ease-in-out infinite .3s"}}>なにか来るかも…！</div>}
        </div>
      )}
      {phase==="show"&&(
        <div style={{textAlign:"center",animation:"pop .35s cubic-bezier(.2,.8,.3,1.3)",padding:"0 20px",width:"100%",maxWidth:340}}>
          {starCount>0 && <div style={{position:"fixed",inset:0,pointerEvents:"none"}}>{[...Array(starCount)].map((_,i)=><span key={i} style={{position:"absolute",left:`${Math.random()*100}%`,top:0,fontSize:isSuper?24:18,animation:`fall ${1+Math.random()*1.5}s ${Math.random()*.8}s linear forwards`}}>{"⭐✨🌟💫🎊"[i%5]}</span>)}</div>}
          <div style={{background:CARD,borderRadius:28,padding:"28px 32px",border:`4px solid ${result.color}`,boxShadow:`0 20px 60px ${result.color}60`,width:"100%"}}>
            <div style={{fontSize:12,color:theme.color,fontWeight:700,background:theme.bg,display:"inline-block",padding:"3px 12px",borderRadius:999,marginBottom:10}}>{theme.emoji} {theme.name}ガチャ</div>
            <p style={{color:result.color,fontWeight:900,fontSize:14,letterSpacing:2,margin:"0 0 8px"}}>{result.emoji} {result.label}</p>
            {result.collItem ? (
              <div style={{position:"relative",margin:"0 auto 4px"}}>
                {result.isNewItem&&<div style={{position:"absolute",top:-10,right:"calc(50% - 42px)",background:R,color:"#fff",borderRadius:999,padding:"2px 10px",fontSize:11,fontWeight:900,zIndex:1,letterSpacing:.5}}>NEW!</div>}
                <img src={`/assets/${result.collItem.id.replace("gi_","gacha_")}.png`} alt={result.collItem.name} style={{width:isSuper?110:88,height:isSuper?110:88,objectFit:"contain",display:"block",margin:"4px auto",borderRadius:14}}/>
                <div style={{fontWeight:900,fontSize:16,color:TEXT,marginBottom:2}}>{result.collItem.name}</div>
                <div style={{fontSize:11,color:MUTED,marginBottom:8}}>{result.collItem.desc}</div>
              </div>
            ) : <div style={{fontSize:isSuper?72:60,margin:"4px 0"}}>{isSuper?"👑":"🎁"}</div>}
            <div style={{color:result.color,fontSize:44,fontWeight:900,lineHeight:1}}>+{result.pts}</div>
            <div style={{color:MUTED,fontSize:14,marginBottom:result.bonusPts>0?6:14}}>ptゲット！</div>
            {result.bonusPts>0&&<div style={{background:GOLDS,borderRadius:10,padding:"5px 12px",marginBottom:12,fontSize:12,fontWeight:700,color:"#9a7000"}}>🔥 ストリークボーナス +{result.bonusPts}pt</div>}
            <button onClick={onClose} style={{background:result.color,border:"none",borderRadius:14,padding:"13px 36px",color:"#fff",fontWeight:900,fontSize:16,cursor:"pointer",fontFamily:F,width:"100%"}}>{isSuper?"🎊 すごい！":"やったー🎉"}</button>
          </div>
        </div>
      )}
      <style>{`
        @keyframes sp{to{transform:rotate(360deg)}}
        @keyframes pop{from{transform:scale(.3);opacity:0}to{transform:scale(1);opacity:1}}
        @keyframes fall{to{transform:translateY(100vh) rotate(360deg);opacity:0}}
        @keyframes heartbeat{0%,100%{transform:scale(1)}14%{transform:scale(1.28)}28%{transform:scale(1.1)}42%{transform:scale(1.32)}70%{transform:scale(1)}}
        @keyframes fadePulse{0%,100%{opacity:1}50%{opacity:0.25}}
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// DAILY TASKS
// ═══════════════════════════════════════════════════════
function DailyTasks({ child, data, update }) {
  const today  = todayKey();
  // アクティブセットを取得（期間チェックあり・null安全）
  const sets = data.dailyTaskSets || [];
  const activeSet = (() => {
    try {
      if (sets.length === 0) return null;
      const byId = sets.find(s => s.id === data.activeSetId && s.active);
      if (byId) {
        if (byId.startDate && today < byId.startDate) {
          // 開始前なら他のアクティブセットを探す
        } else if (byId.endDate && today > byId.endDate) {
          // 期限切れなら他のアクティブセットを探す
        } else {
          return byId;
        }
      }
      // 期間内でactiveなセットを探す
      return sets.find(s => s.active &&
        (!s.startDate || today >= s.startDate) &&
        (!s.endDate   || today <= s.endDate)
      ) || sets.find(s => s.active) || sets[0] || null;
    } catch(e) { return null; }
  })();
  // セットがあればそのタスク、なければlegacy dailyTasksにフォールバック
  const tasks  = (activeSet?.tasks?.length > 0 ? activeSet.tasks : null) || data.dailyTasks || [];
  const bonus  = activeSet?.bonus ?? data.dailyBonus ?? 50;
  const prog   = (data.dailyProgress?.[child.id]?.[today]) || {};
  const [flash, setFlash] = useState(null);

  const showFlash = (pts, emoji) => { setFlash({pts,emoji}); setTimeout(()=>setFlash(null),1100); };

  const isCheck   = t => t.type === "check";
  const isDone    = t => isCheck(t) ? !!prog[t.id] : (prog[t.id]||0) >= (t.target||1);
  const doneCount = tasks.filter(t => isDone(t)).length;
  const allDone   = doneCount === tasks.length && tasks.length > 0;
  const bonusAlreadyGiven = !!prog["__bonus__"];

  const setProgress = (taskId, val) => {
    update(d => ({
      ...d,
      dailyProgress: {
        ...d.dailyProgress,
        [child.id]: { ...(d.dailyProgress?.[child.id]||{}), [today]: { ...((d.dailyProgress?.[child.id]?.[today])||{}), [taskId]: val } }
      }
    }));
  };

  const addLog = (labelOrObj, ptsArg) => {
    // 2つの呼び方に対応:
    // addLog("ラベル", pts) または addLog({cid, type, label, pts, ...})
    const entry = typeof labelOrObj === "object"
      ? { id:uid(), date:new Date().toISOString(), ...labelOrObj }
      : { id:uid(), cid:child.id, type:"daily", label:labelOrObj, pts:ptsArg, date:new Date().toISOString() };

    // 1. ローカルstateに即反映
    update(d => ({ ...d, logs: [entry, ...d.logs] }));
    // 2. Firestoreのlogsコレクションに追記（上書きなし）
    addLogToFirestore(entry);
  };

  const handleCheck = t => {
    if (isDone(t)) return;
    setProgress(t.id, true);
    showFlash(t.pts, t.emoji);
    addLog(`✅ ${t.label}`, t.pts);
    // check if all done after this
    const newProg = { ...prog, [t.id]: true };
    const nowAllDone = tasks.every(tt => tt.type==="check" ? !!newProg[tt.id] : (newProg[tt.id]||0)>=(tt.target||1));
    if (nowAllDone && bonus > 0 && !bonusAlreadyGiven) {
      setTimeout(() => {
        setProgress("__bonus__", true);
        update(d => ({
          ...d,
          logs: [{ id:uid(), cid:child.id, type:"daily", label:"🌟 全タスク達成ボーナス！", pts:bonus, date:new Date().toISOString() }, ...d.logs],
          dailyProgress: {
            ...d.dailyProgress,
            [child.id]: { ...(d.dailyProgress?.[child.id]||{}), [today]: { ...((d.dailyProgress?.[child.id]?.[today])||{}), [t.id]:true, "__bonus__":true } }
          }
        }));
        setFlash({ pts:bonus, emoji:"🌟" });
        setTimeout(()=>setFlash(null),1400);
      }, 600);
    }
  };

  const handleCount = t => {
    const cur = prog[t.id] || 0;
    if (cur >= (t.target||1) && isDone(t)) return;
    const nxt = cur + 1;
    setProgress(t.id, nxt);
    showFlash(t.pts, t.emoji);
    addLog(`🔢 ${t.label}（${nxt}回目）`, t.pts);
  };

  return (
    <div style={{padding:"12px 16px",paddingBottom:0}}>
      {flash && (
        <div style={{position:"fixed",top:"28%",left:"50%",transform:"translate(-50%,-50%)",background:flash.pts>=0?G:R,color:"#fff",borderRadius:20,padding:"13px 24px",zIndex:900,textAlign:"center",animation:"popIn .3s ease"}}>
          <div style={{fontSize:36}}>{flash.emoji}</div>
          <Yen v={flash.pts} sz={20}/>
        </div>
      )}

      {/* Progress bar */}
      <div style={{background:CARD,border:`2px solid ${allDone?"#34c77b":BORDER}`,borderRadius:18,padding:16,marginBottom:14}}>
        {/* セット名表示 */}
        {activeSet&&<div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
          <span style={{fontSize:16}}>{activeSet.emoji}</span>
          <span style={{fontWeight:800,fontSize:12,color:P}}>{activeSet.name}</span>
          {activeSet.endDate&&<span style={{fontSize:10,color:MUTED}}>〜{activeSet.endDate}まで</span>}
        </div>}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <p style={{fontWeight:900,fontSize:14,margin:0,color:allDone?G:TEXT}}>
            {allDone ? "🌟 今日は全部できた！" : "📋 今日のやること"}
          </p>
          <span style={{fontWeight:800,fontSize:13,color:allDone?G:MUTED}}>{doneCount}/{tasks.length}</span>
        </div>
        <div style={{height:10,background:BORDER,borderRadius:5,overflow:"hidden",marginBottom:8}}>
          <div style={{height:"100%",width:`${tasks.length?doneCount/tasks.length*100:0}%`,background:allDone?G:Y,borderRadius:5,transition:"width .5s ease"}}/>
        </div>
        {bonus>0 && (
          <p style={{color:bonusAlreadyGiven?G:MUTED,fontSize:12,fontWeight:700,margin:0}}>
            {bonusAlreadyGiven ? `✅ ボーナス +${bonus}pt もらえた！` : `🎁 全部やると +${bonus}pt ボーナス！`}
          </p>
        )}
        {!activeSet&&tasks.length===0&&<p style={{color:MUTED,fontSize:12,margin:"8px 0 0"}}>アクティブなタスクセットがないよ</p>}
      </div>

      {/* Task list */}
      {tasks.length === 0 && (
        <p style={{color:MUTED,textAlign:"center",fontSize:13,marginTop:20}}>まだデイリータスクがないよ</p>
      )}
      {tasks.map(t => {
        const done = isDone(t);
        const count = isCheck(t) ? null : (prog[t.id]||0);
        return (
          <div key={t.id}
            style={{background:done?"#e8faf0":CARD, border:`2px solid ${done?G:BORDER}`, borderRadius:16, padding:"14px 16px", marginBottom:10, display:"flex", alignItems:"center", gap:12, transition:"all .2s"}}>
            <span style={{fontSize:32}}>{t.emoji}</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:800,fontSize:15,color:done?G:TEXT,textDecoration:done&&isCheck(t)?"line-through":"none"}}>{t.label}</div>
              <div style={{color:MUTED,fontSize:12,marginTop:2}}>
                {isCheck(t) ? `+${t.pts}pt` : `1回 +${t.pts}pt　目標: ${t.target||1}回`}
              </div>
            </div>
            {isCheck(t) ? (
              <button onClick={()=>handleCheck(t)} disabled={done}
                style={{width:44,height:44,borderRadius:"50%",border:`2.5px solid ${done?G:BORDER}`,background:done?G:"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,cursor:done?"default":"pointer",flexShrink:0,transition:"all .2s"}}>
                {done ? "✓" : ""}
              </button>
            ) : (
              <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                <span style={{fontWeight:800,fontSize:14,color:done?G:TEXT}}>{count}/{t.target||1}</span>
                <button onClick={()=>handleCount(t)} disabled={done}
                  style={{width:44,height:44,borderRadius:"50%",border:"none",background:done?G:Y,color:"#fff",fontSize:22,fontWeight:900,cursor:done?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .2s"}}>
                  {done?"✓":"+"}
                </button>
              </div>
            )}
          </div>
        );
      })}
      <style>{`@keyframes popIn{from{transform:translate(-50%,-50%) scale(.5);opacity:0}to{transform:translate(-50%,-50%) scale(1);opacity:1}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// CHILD SCREEN
// ═══════════════════════════════════════════════════════
// ── SettingsModal（親PIN認証後に表示） ────────────────
// ── お手伝い・マイナスタスク管理コンポーネント ──
function TaskManagerSection({data, update}){
  const [tab, setTab] = useState("good"); // good | bad
  const [showAdd, setShowAdd] = useState(false);
  const [newEmoji, setNewEmoji] = useState("⭐");
  const [newLabel, setNewLabel] = useState("");
  const [newPts, setNewPts] = useState("");

  const tasks = tab==="good" ? (data.goodTasks||[]) : (data.badTasks||[]);
  const key = tab==="good" ? "goodTasks" : "badTasks";

  const doAdd = () => {
    if(!newLabel.trim()||!newPts) return;
    const pts = parseInt(newPts);
    if(isNaN(pts)) return;
    const finalPts = tab==="bad" ? -Math.abs(pts) : Math.abs(pts);
    update(d=>({...d,[key]:[...d[key],{id:uid(),emoji:newEmoji,label:newLabel.trim(),pts:finalPts,over:{}}]}));
    setNewLabel(""); setNewPts(""); setNewEmoji("⭐"); setShowAdd(false);
  };

  const doDelete = (id) => {
    update(d=>({...d,[key]:d[key].filter(t=>t.id!==id)}));
  };

  return(
    <div style={{marginBottom:8}}>
      <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 8px"}}>
        {tab==="good"?"✅ お手伝い項目":"❌ マイナス項目"}
      </p>
      {/* good/bad切替 */}
      <div style={{display:"flex",gap:6,marginBottom:10}}>
        {[["good","✅ お手伝い"],["bad","❌ マイナス"]].map(([v,l])=>(
          <button key={v} onClick={()=>{setTab(v);setShowAdd(false);}}
            style={{flex:1,padding:"7px 0",border:`1.5px solid ${tab===v?(v==="good"?G:R):BORDER}`,
              borderRadius:10,background:tab===v?(v==="good"?`${G}15`:`${R}15`):"transparent",
              color:tab===v?(v==="good"?G:R):MUTED,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
            {l}
          </button>
        ))}
      </div>
      {/* タスク一覧 */}
      <div style={{maxHeight:200,overflowY:"auto",marginBottom:8}}>
        {tasks.map(t=>(
          <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,background:CARD,
            border:`1.5px solid ${BORDER}`,borderRadius:10,padding:"8px 10px",marginBottom:5}}>
            <span style={{fontSize:18}}>{t.emoji}</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:12,color:TEXT}}>{t.label}</div>
              <div style={{fontSize:11,color:t.pts>0?G:R,fontWeight:700}}>{t.pts>0?"+":""}{t.pts}pt</div>
            </div>
            <button onClick={()=>doDelete(t.id)}
              style={{padding:"3px 8px",background:`${R}15`,border:`1.5px solid ${R}`,
                borderRadius:7,color:R,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
              削除
            </button>
          </div>
        ))}
      </div>
      {/* 追加フォーム */}
      {showAdd ? (
        <div style={{background:BG,borderRadius:12,padding:"12px",border:`1.5px solid ${tab==="good"?G:R}`}}>
          <div style={{display:"flex",gap:6,marginBottom:8}}>
            <input value={newEmoji} onChange={e=>setNewEmoji(e.target.value)}
              style={{width:50,padding:"8px",border:`1.5px solid ${BORDER}`,borderRadius:8,
                fontSize:18,textAlign:"center",fontFamily:F,background:CARD}}/>
            <input value={newLabel} onChange={e=>setNewLabel(e.target.value)}
              placeholder="項目名" maxLength={20}
              style={{flex:1,padding:"8px 10px",border:`1.5px solid ${BORDER}`,borderRadius:8,
                fontSize:13,fontFamily:F,background:CARD}}/>
          </div>
          <div style={{display:"flex",gap:6,marginBottom:8}}>
            <input value={newPts} onChange={e=>setNewPts(e.target.value)}
              type="number" placeholder="pt数"
              style={{flex:1,padding:"8px 10px",border:`1.5px solid ${BORDER}`,borderRadius:8,
                fontSize:13,fontFamily:F,background:CARD}}/>
            <span style={{padding:"8px 4px",fontSize:12,color:MUTED,alignSelf:"center"}}>pt</span>
          </div>
          {/* クイック選択pt */}
          <div style={{display:"flex",gap:4,marginBottom:10,flexWrap:"wrap"}}>
            {[5,10,20,30,50,100].map(v=>(
              <button key={v} onClick={()=>setNewPts(String(v))}
                style={{padding:"4px 10px",border:`1.5px solid ${newPts===String(v)?(tab==="good"?G:R):BORDER}`,
                  borderRadius:8,background:newPts===String(v)?(tab==="good"?`${G}20`:`${R}20`):"transparent",
                  color:newPts===String(v)?(tab==="good"?G:R):MUTED,
                  fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
                {v}
              </button>
            ))}
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={doAdd}
              style={{flex:1,padding:"9px",background:tab==="good"?G:R,border:"none",borderRadius:10,
                color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
              ✅ 追加する
            </button>
            <button onClick={()=>setShowAdd(false)}
              style={{padding:"9px 14px",background:`${MUTED}20`,border:`1.5px solid ${BORDER}`,
                borderRadius:10,color:MUTED,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <button onClick={()=>setShowAdd(true)}
          style={{width:"100%",padding:"10px",background:`${tab==="good"?G:R}15`,
            border:`2px dashed ${tab==="good"?G:R}`,borderRadius:12,
            color:tab==="good"?G:R,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
          ＋ 新しい{tab==="good"?"お手伝い":"マイナス"}項目を追加
        </button>
      )}
    </div>
  );
}


function SettingsModal({data, update, onClose, currentMemberId}) {
  const [authed, setAuthed] = useState(false);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState("quick");
  const [settingsTab, setSettingsTab] = useState((data.pendingApprovals||[]).length>0?"approval":"grant");
  const [grantChild, setGrantChild] = useState(null);
  const [grantAmt, setGrantAmt] = useState("");
  const [taskAssignChild, setTaskAssignChild] = useState(null);
  const [copied, setCopied] = useState(false);

  const F = "'M PLUS Rounded 1c','Hiragino Maru Gothic ProN',sans-serif";
  const G="#34c77b",Y="#f5c842",R="#f0605a",B="#4a9eff",P="#a855f7";
  const TEXT="#1a1a2a",MUTED="#9ca3af",CARD="#ffffff",BG="#f8f9fa",BORDER="#e5e7eb";
  const INP = {width:"100%",padding:"10px 14px",border:`1.5px solid ${BORDER}`,borderRadius:10,fontSize:14,fontFamily:F,background:BG,outline:"none"};

  // PIN認証
  const handlePin = (k) => {
    if(pinErr){setPinErr(false);setPin("");}
    const next = pin + k;
    setPin(next);
    if(next.length === 4) {
      if(next === data.parentPin) {
        setTimeout(()=>{
          setAuthed(true);
          if(data.parentPin==="0000"){ setSettingsGroup("adv"); setSettingsTab("members"); }
        }, 200);
      } else {
        setTimeout(()=>{setPinErr(true);setPin("");}, 300);
      }
    }
  };

  const QUICK_TABS = [["grant","🎁 pt付与"],["approval","✅ 承認"]];
  const ADV_TABS   = [["tasks","📋 タスク"],["assign","👤 割当"],["rewards","🎁 特典"],["interest","💹 利子"],["members","🔐 PIN"],["transfer","🔄 引継"]];
  const SETTING_TABS = settingsGroup==="quick" ? QUICK_TABS : ADV_TABS;

  if(!authed) return (
    <div style={{position:"fixed",inset:0,background:"#000a",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      <div style={{background:CARD,borderRadius:24,padding:"32px 24px",width:"100%",maxWidth:320,textAlign:"center",boxShadow:"0 8px 40px #0004"}}>
        <div style={{fontSize:44,marginBottom:8}}>🔐</div>
        <h3 style={{fontWeight:900,fontSize:18,color:TEXT,margin:"0 0 4px"}}>設定・管理</h3>
        <p style={{color:MUTED,fontSize:12,margin:"0 0 12px"}}>おや用PIN（初期：0000）</p>
        {data.parentPin==="0000"&&(
          <div style={{background:`${R}12`,border:`1.5px solid ${R}50`,borderRadius:12,padding:"10px 14px",marginBottom:14,textAlign:"left"}}>
            <p style={{margin:0,fontSize:12,color:R,fontWeight:700}}>⚠ PINが初期値のままです</p>
            <p style={{margin:"3px 0 0",fontSize:11,color:MUTED}}>認証後、すぐに変更してください</p>
          </div>
        )}
        <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:16}}>
          {[0,1,2,3].map(i=>(
            <div key={i} style={{width:14,height:14,borderRadius:"50%",background:pin.length>i?(pinErr?R:TEXT):BORDER,transition:"background .15s"}}/>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
          {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
            <button key={i} onClick={()=>k==="⌫"?setPin(p=>p.slice(0,-1)):k!==""&&handlePin(String(k))}
              style={{padding:"16px 0",border:`1.5px solid ${BORDER}`,borderRadius:12,background:k===""?"transparent":CARD,fontSize:20,fontWeight:700,cursor:k===""?"default":"pointer",fontFamily:F,color:TEXT}}>
              {k}
            </button>
          ))}
        </div>
        {pinErr&&<p style={{color:R,fontSize:12,margin:"0 0 8px",fontWeight:700}}>PINが違います</p>}
        <button onClick={onClose} style={{background:"none",border:"none",color:MUTED,fontSize:13,cursor:"pointer",fontFamily:F}}>キャンセル</button>
      </div>
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"#000a",zIndex:9999,display:"flex",alignItems:"flex-end",fontFamily:F}}>
      <div style={{background:CARD,borderRadius:"24px 24px 0 0",width:"100%",maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        {/* ヘッダー */}
        <div style={{padding:"20px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <div>
            <h3 style={{fontWeight:900,fontSize:18,color:TEXT,margin:"0 0 2px"}}>⚙ 全体管理</h3>
            <p style={{color:MUTED,fontSize:11,margin:0}}>家族全員のポイント・タスクを管理</p>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:MUTED}}>✕</button>
        </div>
        {/* グループ切り替え */}
        <div style={{display:"flex",gap:6,padding:"12px 16px 0",flexShrink:0}}>
          {[["quick","⚡ よく使う"],["adv","⚙ 詳細設定"]].map(([g,l])=>(
            <button key={g} onClick={()=>{setSettingsGroup(g);setSettingsTab(g==="quick"?"grant":"tasks");}}
              style={{flex:1,padding:"7px 0",borderRadius:10,border:"none",background:settingsGroup===g?GP:"transparent",color:settingsGroup===g?"#fff":MUTED,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>
              {l}
            </button>
          ))}
        </div>
        {/* タブ */}
        <div style={{display:"flex",gap:0,padding:"6px 16px 0",overflowX:"auto",flexShrink:0}}>
          {SETTING_TABS.map(([v,l])=>(
            <button key={v} onClick={()=>setSettingsTab(v)}
              style={{padding:"8px 14px",border:"none",borderBottom:settingsTab===v?`3px solid ${Y}`:"3px solid transparent",background:"none",color:settingsTab===v?TEXT:MUTED,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap"}}>
              {l}{v==="approval"&&(data.pendingApprovals||[]).length>0&&<span style={{marginLeft:5,background:R,color:"#fff",borderRadius:999,padding:"0 5px",fontSize:10,fontWeight:900}}>{(data.pendingApprovals||[]).length}</span>}
            </button>
          ))}
        </div>
        {/* コンテンツ */}
        <div style={{flex:1,overflowY:"auto",padding:"16px"}}>

          {/* ── pt付与タブ ── */}
          {settingsTab==="grant"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>ポイントを付与する</p>
              {[...data.children,...(data.parents||[])].map(member=>(
                <div key={member.id} style={{background:grantChild===member.id?`${Y}15`:BG,border:`1.5px solid ${grantChild===member.id?Y:BORDER}`,borderRadius:14,padding:"12px 14px",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:grantChild===member.id?10:0}}>
                    <ChildAvatar child={member} size={36}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:14}}>{member.name}</div>
                      <div style={{color:MUTED,fontSize:11}}>{bal(data.logs,member.id).toLocaleString()}pt</div>
                    </div>
                    <button onClick={()=>setGrantChild(grantChild===member.id?null:member.id)}
                      style={{padding:"6px 14px",background:Y,border:"none",borderRadius:10,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,color:TEXT}}>
                      {grantChild===member.id?"閉じる":"付与"}
                    </button>
                  </div>
                  {grantChild===member.id&&(
                    <div>
                      <div style={{display:"flex",gap:6,marginBottom:8}}>
                        {[10,30,50,100,200,500].map(v=>(
                          <button key={v} onClick={()=>setGrantAmt(String(v))}
                            style={{flex:1,padding:"6px 0",border:`1.5px solid ${grantAmt===String(v)?Y:BORDER}`,borderRadius:8,background:grantAmt===String(v)?`${Y}20`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:grantAmt===String(v)?"#9a7000":MUTED}}>
                            {v}
                          </button>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <input value={grantAmt} onChange={e=>setGrantAmt(e.target.value)} type="number" placeholder="pt数" style={{...INP,flex:1}}/>
                        <button onClick={()=>{
                          const amt=parseInt(grantAmt);
                          if(isNaN(amt)||amt===0) return;
                          (()=>{const _e={id:uid(),cid:member.id,type:"grant",label:`🎁 親からのポイント付与`,pts:amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);})();
                          setGrantAmt("");setGrantChild(null);
                        }} style={{padding:"10px 16px",background:G,border:"none",borderRadius:10,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                          付与
                        </button>
                      </div>
                      <div style={{display:"flex",gap:8,marginTop:6}}>
                        <button onClick={()=>{
                          const amt=parseInt(grantAmt);
                          if(isNaN(amt)||amt===0) return;
                          (()=>{const _e={id:uid(),cid:member.id,type:"grant",label:`⚠ ポイント減算`,pts:-amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);})();
                          setGrantAmt("");setGrantChild(null);
                        }} style={{flex:1,padding:"8px 0",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,color:R,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
                          −減算
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── タスク管理タブ ── */}
          {settingsTab==="tasks"&&(
            <div>
              {/* お手伝い項目管理 */}
              <TaskManagerSection data={data} update={update}/>
              {/* 毎日タスク管理 */}
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"16px 0 8px"}}>📋 毎日タスク管理</p>
              <ParentDailyTab data={data} update={update} sb={(c,l,fn)=><button onClick={fn} style={{padding:"5px 10px",background:`${c}20`,border:`1.5px solid ${c}`,borderRadius:8,color:c,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>}/>
            </div>
          )}

          {/* ── 個別タスク割り当てタブ ── */}
          {settingsTab==="assign"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>メンバーごとのタスク割り当て</p>
              {[...data.children,...(data.parents||[])].map(member=>(
                <div key={member.id} style={{marginBottom:12}}>
                  <button onClick={()=>setTaskAssignChild(taskAssignChild===member.id?null:member.id)}
                    style={{width:"100%",background:taskAssignChild===member.id?`${B}10`:CARD,border:`2px solid ${taskAssignChild===member.id?B:BORDER}`,borderRadius:14,padding:"12px 14px",display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left",fontFamily:F}}>
                    <ChildAvatar child={member} size={36}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:14}}>{member.name}</div>
                      <div style={{color:MUTED,fontSize:11}}>
                        カスタムタスク: {((data.myTaskIds||{})[member.id]||[]).length}件
                      </div>
                    </div>
                    <span style={{color:MUTED,fontSize:16}}>{taskAssignChild===member.id?"▲":"▼"}</span>
                  </button>
                  {taskAssignChild===member.id&&(
                    <div style={{background:BG,borderRadius:"0 0 14px 14px",padding:"12px 14px",border:`2px solid ${B}`,borderTop:"none"}}>
                      <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>
                        タスクを選んで{member.name}専用リストに追加
                      </p>
                      <div style={{maxHeight:240,overflowY:"auto",display:"flex",flexDirection:"column",gap:5}}>
                        {(data.goodTasks||[]).map(t=>{
                          const assigned=((data.myTaskIds||{})[member.id]||[]).includes(t.id);
                          return(
                            <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,background:assigned?`${G}10`:CARD,border:`1.5px solid ${assigned?G:BORDER}`,borderRadius:10,padding:"8px 12px"}}>
                              <span style={{fontSize:18}}>{t.emoji}</span>
                              <div style={{flex:1}}>
                                <div style={{fontWeight:700,fontSize:12}}>{t.label}</div>
                                <div style={{color:MUTED,fontSize:10}}>+{t.pts}pt</div>
                              </div>
                              <button onClick={()=>update(d=>{
                                const cur=(d.myTaskIds||{})[member.id]||[];
                                const next=assigned?cur.filter(id=>id!==t.id):[...cur,t.id];
                                return{...d,myTaskIds:{...(d.myTaskIds||{}),[member.id]:next}};
                              })} style={{padding:"4px 10px",background:assigned?`${R}15`:`${G}15`,border:`1.5px solid ${assigned?R:G}`,borderRadius:8,color:assigned?R:G,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
                                {assigned?"解除":"追加"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── 特典管理タブ ── */}
          {settingsTab==="rewards"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>こうかんアイテムの管理</p>
              {(data.rewards||[]).map(r=>(
                <div key={r.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                  {/^r0\d$/.test(r.id)?<img src={`/assets/reward_${r.id}.png`} style={{width:30,height:30,objectFit:"contain",borderRadius:6,flexShrink:0}} alt=""/>:<span style={{fontSize:22}}>{r.emoji}</span>}
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13}}>{r.label}</div>
                    <div style={{color:MUTED,fontSize:11}}>{r.cost}pt · {r.unit}</div>
                  </div>
                  <button onClick={()=>update(d=>({...d,rewards:d.rewards.filter(x=>x.id!==r.id)}))}
                    style={{padding:"4px 10px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:8,color:R,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>削除</button>
                </div>
              ))}
              <button onClick={()=>{
                const label=prompt("ご褒美名");if(!label)return;
                const cost=parseInt(prompt("必要pt"));if(isNaN(cost))return;
                const emoji=prompt("絵文字","🎁")||"🎁";
                const unit=prompt("単位（例：1回）","1回")||"1回";
                update(d=>({...d,rewards:[...d.rewards,{id:uid(),emoji,label,cost,unit}]}));
              }} style={{width:"100%",padding:"12px",background:`${G}15`,border:`2px dashed ${G}`,borderRadius:12,color:G,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                ＋ 新しいご褒美を追加
              </button>
            </div>
          )}

          {/* ── メンバー管理タブ ── */}
          {settingsTab==="interest"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 16px"}}>週次利子の設定</p>
              {/* 利子ON/OFF */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>利子システム</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>週1回、残高に利子を付与</div>
                </div>
                <button onClick={()=>update(d=>({...d,interestEnabled:!d.interestEnabled}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:data.interestEnabled?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:data.interestEnabled?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* 利率設定 */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10}}>
                <div style={{fontWeight:800,fontSize:14,color:TEXT,marginBottom:8}}>利率</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                  {[1,2,3,5,10].map(r=>(
                    <button key={r} onClick={()=>update(d=>({...d,interestRate:r/100}))}
                      style={{padding:"6px 14px",border:`1.5px solid ${Math.round((data.interestRate||0.05)*100)===r?G:BORDER}`,
                        borderRadius:10,background:Math.round((data.interestRate||0.05)*100)===r?`${G}20`:"transparent",
                        color:Math.round((data.interestRate||0.05)*100)===r?G:MUTED,
                        fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                      {r}%
                    </button>
                  ))}
                </div>
                <div style={{fontSize:12,color:MUTED}}>
                  現在の利率：<span style={{fontWeight:800,color:G}}>{Math.round((data.interestRate||0.05)*100)}%</span>
                </div>
              </div>
              {/* 対象メンバー別残高と予想利子 */}
              <div style={{background:BG,borderRadius:14,padding:"12px 14px",border:`1.5px solid ${BORDER}`}}>
                <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>次回付与予定（参考）</p>
                {[...data.children,...(data.parents||[])].map(m=>{
                  const b=bal(data.logs,m.id);
                  const interest=data.interestEnabled&&b>0?Math.floor(b*(data.interestRate||0.05)):0;
                  return(
                    <div key={m.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                      <span style={{fontSize:18}}>{m.emoji}</span>
                      <div style={{flex:1,fontWeight:700,fontSize:12,color:TEXT}}>{m.name}</div>
                      <div style={{fontSize:12,color:MUTED}}>{b.toLocaleString()}pt</div>
                      <div style={{fontSize:12,fontWeight:700,color:interest>0?G:MUTED}}>
                        {interest>0?`+${interest}pt`:"−"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

settingsTab==="members"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>メンバーとPIN管理</p>
              {[{id:"parent",name:"おや管理",emoji:"🔐",pin:data.parentPin,isParent:true},...data.children,(data.parents||[])].flat().filter((x,i,a)=>x&&a.findIndex(y=>y&&y.id===x.id)===i).map(m=>{
                if(!m) return null;
                return(
                  <div key={m.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:24}}>{m.emoji}</span>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13}}>{m.name}</div>
                      <div style={{color:MUTED,fontSize:11}}>PIN: {'*'.repeat(4)}</div>
                    </div>
                    <button onClick={()=>{
                      const np=prompt(`${m.name}の新しいPIN（4桁）`);
                      if(!np||np.length!==4||isNaN(Number(np))){alert("4桁の数字を入力してください");return;}
                      if(m.isParent||m.id==="parent") update(d=>({...d,parentPin:np}));
                      else update(d=>({...d,children:d.children.map(c=>c.id===m.id?{...c,pin:np}:c),parents:(d.parents||[]).map(p=>p.id===m.id?{...p,pin:np}:p)}));
                    }} style={{padding:"6px 12px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:8,color:B,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
                      PIN変更
                    </button>
                    {/* 親以外はPINなしトグル */}
                    {!m.isParent&&m.id!=="parent"&&(
                      <button onClick={()=>{
                        const noPinNow = !!(data.noPinIds||{})[m.id];
                        update(d=>({...d,
                          noPinIds:{...(d.noPinIds||{}),[m.id]:!noPinNow},
                          pinChanged:{...(d.pinChanged||{}),[m.id]:true}, // 強制変更スキップ
                          lockEnabled:{...(d.lockEnabled||{}),[m.id]:false}, // lockをOFFに
                        }));
                      }} style={{padding:"6px 12px",
                        background:(data.noPinIds||{})[m.id]?`${R}15`:`${G}15`,
                        border:`1.5px solid ${(data.noPinIds||{})[m.id]?R:G}`,
                        borderRadius:8,color:(data.noPinIds||{})[m.id]?R:G,
                        fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
                        {(data.noPinIds||{})[m.id]?"🔓 PINなし":"🔒 PIN有り"}
                      </button>
                    )}
                  </div>
                );
              })}
              {/* ファミリーコード */}
              <div style={{background:BG,borderRadius:12,padding:"12px 14px",marginTop:8,border:`1.5px solid ${BORDER}`}}>
                <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 4px"}}>ファミリーコード</p>
                <p style={{fontWeight:900,fontSize:16,letterSpacing:3,margin:"0 0 8px"}}>{(()=>{try{return localStorage.getItem("tane_money_family_code")||"---";}catch(e){return "---";}})()}</p>
                <p style={{color:MUTED,fontSize:10,margin:"0 0 10px"}}>このコードを家族に共有してください</p>
                <button onClick={()=>{
                  const newCode=prompt("新しいファミリーコードを入力（例：TANE-YUTA）");
                  if(!newCode)return;
                  const code=newCode.trim().toUpperCase();
                  try{localStorage.setItem("tane_money_family_code",code);}catch(e){}
                  _familyCode=code;
                  alert("コードを変更しました。ページを再読み込みします。");
                  window.location.reload();
                }} style={{width:"100%",padding:"9px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:10,color:B,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,marginBottom:8}}>
                  🔗 ファミリーコードを変更
                </button>
                <button onClick={()=>{
                  if(!confirm("このiPhoneからログアウトしますか？\nファミリーコード入力画面に戻ります。"))return;
                  try{localStorage.removeItem("tane_money_family_code");}catch(e){}
                  _familyCode=null;
                  window.location.reload();
                }} style={{width:"100%",padding:"9px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,color:R,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
                  🚪 このiPhoneからログアウト
                </button>
              </div>
            </div>
          )}

          {/* ── 承認タブ ── */}
          {settingsTab==="approval"&&(()=>{
            const fs=data.familySettings||INIT.familySettings;
            const pending=data.pendingApprovals||[];
            const approve=(entry)=>{
              const log={id:uid(),cid:entry.cid,type:"good",label:entry.taskLabel,pts:entry.pts,date:new Date().toISOString(),rid:entry.taskId};
              addLogToFirestore(log);
              update(d=>({...d,logs:[log,...d.logs],pendingApprovals:(d.pendingApprovals||[]).filter(p=>p.id!==entry.id)}));
            };
            const reject=(entry)=>{
              update(d=>({...d,pendingApprovals:(d.pendingApprovals||[]).filter(p=>p.id!==entry.id)}));
            };
            return(<div>
              {/* 承認モード切り替え */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>タスク承認が必要</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>ONにすると、子どものお手伝い記録を親が承認</div>
                </div>
                <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),requireApproval:!fs.requireApproval}}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:fs.requireApproval?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:fs.requireApproval?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* 承認待ちキュー */}
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 10px"}}>承認待ち（{pending.length}件）</p>
              {pending.length===0&&<div style={{textAlign:"center",padding:"24px 0",color:MUTED,fontSize:13}}>承認待ちのタスクはありません</div>}
              {pending.map(entry=>{
                const member=[...data.children,...(data.parents||[])].find(m=>m.id===entry.cid);
                return(
                  <div key={entry.id} style={{background:GOLDS,border:`1.5px solid ${GOLD}`,borderRadius:14,padding:"12px 14px",marginBottom:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      <span style={{fontSize:26}}>{entry.taskEmoji}</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{entry.taskLabel}</div>
                        <div style={{fontSize:11,color:MUTED}}>{member?.name||"?"} · +{entry.pts}pt</div>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>approve(entry)} style={{flex:1,background:G,border:"none",borderRadius:10,padding:"9px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>✅ 承認</button>
                      <button onClick={()=>reject(entry)} style={{flex:1,background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,padding:"9px",color:R,fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>❌ 却下</button>
                    </div>
                  </div>
                );
              })}
            </div>);
          })()}

          {/* ── 引き継ぎタブ ── */}
          {settingsTab==="transfer"&&(()=>{
            const code=(()=>{try{return localStorage.getItem(FAMILY_CODE_KEY)||"---";}catch(e){return"---";}})();
            return(<div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 16px"}}>スマホ引き継ぎ・共有</p>
              {/* ファミリーコード表示 */}
              <div style={{background:`linear-gradient(135deg,${GS},#fff)`,border:`2px solid ${G}`,borderRadius:16,padding:"20px",textAlign:"center",marginBottom:16}}>
                <div style={{fontSize:12,color:MUTED,fontWeight:700,marginBottom:8}}>あなたのファミリーコード</div>
                <div style={{fontWeight:900,fontSize:28,letterSpacing:4,color:GP,marginBottom:8}}>{code}</div>
                <div style={{fontSize:11,color:MUTED,marginBottom:14}}>このコードを新しいスマホや家族に共有してください</div>
                <button onClick={()=>{try{navigator.clipboard.writeText(code);}catch(e){}setCopied(true);setTimeout(()=>setCopied(false),2000);}}
                  style={{background:copied?G:GP,border:"none",borderRadius:12,padding:"10px 28px",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F,transition:"background .3s"}}>
                  {copied?"✅ コピーしました！":"📋 コードをコピー"}
                </button>
              </div>
              {/* 手順説明 */}
              <div style={{background:BG,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px"}}>
                <p style={{fontWeight:800,fontSize:13,color:TEXT,margin:"0 0 10px"}}>📱 新しいスマホへの引き継ぎ手順</p>
                {[["1","新しいスマホでTane Moneyを開く"],["2","「すでにコードがある」をタップ"],["3","上のコードを入力"],["4","データが同期される"]].map(([n,t])=>(
                  <div key={n} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:8}}>
                    <div style={{width:22,height:22,borderRadius:"50%",background:GP,color:"#fff",fontWeight:800,fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{n}</div>
                    <div style={{fontSize:12,color:TEXT,lineHeight:1.6,paddingTop:2}}>{t}</div>
                  </div>
                ))}
              </div>
              {/* データエクスポート */}
              <div style={{background:BG,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginTop:14}}>
                <p style={{fontWeight:800,fontSize:13,color:TEXT,margin:"0 0 8px"}}>📊 データをエクスポート</p>
                <p style={{fontSize:11,color:MUTED,margin:"0 0 12px"}}>全ログをCSVファイルでダウンロードできます（Excel対応）</p>
                <button onClick={()=>{
                  const rows=[["日付","子ども","種別","内容","pt"]];
                  (data.logs||[]).forEach(l=>{
                    const c=(data.children||[]).find(x=>x.id===l.cid);
                    rows.push([(l.date||"").slice(0,10),c?.name||"",l.type,l.label||"",l.pts||0]);
                  });
                  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(",")).join("\n");
                  const blob=new Blob([""+csv],{type:"text/csv;charset=utf-8"});
                  const url=URL.createObjectURL(blob);
                  const a=document.createElement("a");
                  a.href=url;a.download=`tane-money-${new Date().toISOString().slice(0,7)}.csv`;
                  document.body.appendChild(a);a.click();document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }} style={{width:"100%",padding:"11px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:12,color:B,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                  ⬇ CSVダウンロード
                </button>
              </div>
              {/* ログアウト */}
              <button onClick={()=>{
                if(!confirm("このiPhoneからログアウトしますか？\nコードを入力すれば再びアクセスできます。"))return;
                try{localStorage.removeItem(FAMILY_CODE_KEY);}catch(e){}
                _familyCode=null;window.location.reload();
              }} style={{width:"100%",padding:"11px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:12,color:R,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F,marginTop:14}}>
                🚪 このiPhoneからログアウト
              </button>
            </div>);
          })()}
        </div>
      </div>
    </div>
  );
}


function ChildScreen({ child, data, update, onBack, onFamily }) {
  const [tab, setTab]   = useState("daily");
  const [flash, setFlash] = useState(null);
  const [pressed, setPressed] = useState({});
  const [gachaRes, setGachaRes] = useState(null);
  const [rewardPop, setRewardPop] = useState(null);
  const [showWeekly, setShowWeekly] = useState(false);
  const [showCustomizer, setShowCustomizer] = useState(false);
  const [goalCelebration, setGoalCelebration] = useState(null);
  const [actTab, setActTab] = useState("tasks");
  const [moreOpen, setMoreOpen] = useState(false);
  const [monTab, setMonTab] = useState("goals");
  const [taskSort, setTaskSort] = useState("default");
  const [rewardSort, setRewardSort] = useState("default");
  const [logSort, setLogSort] = useState("new");
  const [showSettings, setShowSettings] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showZukan, setShowZukan] = useState(false);

  const ageMode  = child.ageMode || "middle";
  const young    = ageMode === "young";
  const isJunior = child.displayMode === "junior"; // Junior/Teenモード分岐
  const thisMonth = new Date().toISOString().slice(0,7);
  const monthDelta = (data.logs||[]).filter(l=>l.cid===child.id&&(l.date||"").startsWith(thisMonth)).reduce((s,l)=>s+l.pts,0);
  const myBal    = bal(data.logs, child.id);
  const myLogs   = (data.logs||[]).filter(l=>l.cid===child.id);
  const todayDone= data.gachaDate?.[child.id] === todayKey();
  const curStreak= data.streak?.[child.id]?.cur || 0;
  const doneTodayIds = new Set(myLogs.filter(l=>l.rid&&(l.date||"").startsWith(todayKey())).map(l=>l.rid));
  const todayTaskDone = myLogs.some(l=>l.type==="good"&&(l.date||"").startsWith(todayKey()));

  // Apply interest on open
  useEffect(()=>{ applyInterest(data,update,child.id); applyHoldingBonus(data,update,child.id); fetchRealStockPrices(data,update); },[]);

  const showFlash = (pts, emoji) => {
    setFlash({pts,emoji}); setTimeout(()=>setFlash(null),1200);
  };

  const addLog = (entry) => {
    update(d => ({ ...d, logs: [{ id:uid(), date:new Date().toISOString(), ...entry }, ...d.logs] }));
  };

  const doTask = task => {
    const pts = taskPts(task, child.id);
    const fs = data.familySettings || INIT.familySettings;
    const needApproval = fs.requireApproval && pts > 0;
    const alreadyPending = (data.pendingApprovals||[]).some(p=>p.cid===child.id&&p.taskId===task.id);
    if(alreadyPending) return;
    if(doneTodayIds.has(task.id)) return;
    setPressed(p=>({...p,[task.id]:true}));
    setTimeout(()=>setPressed(p=>{const n={...p};delete n[task.id];return n;}),500);
    if(needApproval) {
      setFlash({pts:0,emoji:"⏳",pending:true});
      setTimeout(()=>setFlash(null),1400);
      const entry={id:uid(),cid:child.id,taskId:task.id,taskLabel:task.label,taskEmoji:task.emoji,pts,date:new Date().toISOString()};
      update(d=>({...d,pendingApprovals:[...(d.pendingApprovals||[]),entry]}));
    } else {
      showFlash(pts, task.emoji);
      addLog({ cid:child.id, type: pts>=0?"good":"bad", label:task.label, pts, rid:task.id });
    }
  };

  const doRedeem = r => {
    showFlash(-r.cost, r.emoji);
    setRewardPop(null);
    addLog({ cid:child.id, type:"reward", label:`${r.label}（${r.unit}）`, pts:-r.cost, rid:r.id });
  };

  const doGacha = () => {
    if (todayDone) return;
    const res = rollGacha(data.gacha);
    const theme = getMonthTheme();
    const bonusPts = curStreak>=30?50:curStreak>=10?20:curStreak>=5?10:0;
    const tierItems = GACHA_ITEMS.filter(i=>i.tierId===res.id);
    const collItem = tierItems.length>0 ? tierItems[Math.floor(Math.random()*tierItems.length)] : null;
    const isNewItem = collItem ? !(data.gachaCollection?.[child.id]?.[collItem.id]) : false;
    const finalRes = {...res, pts:res.pts+bonusPts, bonusPts, theme, collItem, isNewItem};
    setGachaRes(finalRes);
    const today = todayKey();
    const prev  = data.streak?.[child.id] || { cur:0, max:0, last:"" };
    const yesterday = (()=>{ const d=new Date(); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; })();
    const newCur = prev.last===yesterday ? prev.cur+1 : 1;
    update(d => ({
      ...d,
      logs: (()=>{ const _e={ id:uid(), cid:child.id, type:"gacha", label:`🎰 ガチャ（${res.label}）`, pts:finalRes.pts, date:new Date().toISOString(), rare:res.rate<=3, tierId:res.id, collItemId:collItem?.id }; addLogToFirestore(_e); return[_e,...d.logs]; })(),
      gachaDate: {...(d.gachaDate||{}), [child.id]: today},
      streak: {...(d.streak||{}), [child.id]: { cur:newCur, max:Math.max(prev.max||0,newCur), last:today }},
      gachaCollection: collItem ? {...(d.gachaCollection||{}), [child.id]: {...(d.gachaCollection?.[child.id]||{}), [collItem.id]:((d.gachaCollection?.[child.id]?.[collItem.id]||0)+1)}} : (d.gachaCollection||{}),
    }));
  };

  // Kakeibo state
  const [kTab,  setKTab]  = useState("graph");
  const [kMonth,setKMonth]= useState(monthKey());
  const [kForm, setKForm] = useState({catId:"cat1",label:"",amt:""});
  const [kAdd,  setKAdd]  = useState(false);

  const kExps = (data.expenses||[]).filter(e=>e.cid===child.id&&(e.date||"").startsWith(kMonth));
  const kCatData = (data.cats||[]).map(cat=>({ ...cat, v:kExps.filter(e=>e.catId===cat.id).reduce((s,e)=>s+e.amt,0) })).filter(c=>c.v>0).sort((a,b)=>b.v-a.v);
  const kTotal = kExps.reduce((s,e)=>s+e.amt,0);
  const kLife  = (data.expenses||[]).filter(e=>e.cid===child.id).reduce((s,e)=>s+e.amt,0);
  const kMax   = kCatData[0]?.v||1;

  const addExpense = () => {
    const amt=parseInt(kForm.amt); if(!kForm.label||isNaN(amt)||amt<=0)return;
    update(d=>({...d,expenses:[{id:uid(),cid:child.id,catId:kForm.catId,label:kForm.label,amt,date:new Date().toISOString()},...(d.expenses||[])]}));
    setKForm({catId:"cat1",label:"",amt:""}); setKAdd(false);
  };
  const delExpense = id => update(d=>({...d,expenses:(d.expenses||[]).filter(e=>e.id!==id)}));

  // Goals
  const [gForm,setGForm]=useState({emoji:"🎯",label:"",target:""});
  const [gAdd,setGAdd]=useState(false);
  const myGoals = (data.goals||[]).filter(g=>g.cid===child.id);

  const addGoal = () => {
    const t=parseInt(gForm.target); if(!gForm.label||isNaN(t)||t<=0)return;
    update(d=>({...d,goals:[...( d.goals||[]),{id:uid(),cid:child.id,emoji:gForm.emoji,label:gForm.label,target:t,done:false}]}));
    setGForm({emoji:"🎯",label:"",target:""}); setGAdd(false);
  };
  const markGoal = id => {
    const g=(data.goals||[]).find(x=>x.id===id);
    update(d=>({...d,goals:(d.goals||[]).map(x=>x.id===id?{...x,done:true,doneDate:new Date().toISOString()}:x)}));
    if(g) setGoalCelebration(g);
  };
  const delGoal  = id => update(d=>({...d,goals:(d.goals||[]).filter(g=>g.id!==id)}));

  // MyTasks filter
  const myIds = (data.myTaskIds||{})[child.id]||[];
  const hasFilter = myIds.length>0;
  const filtGood = hasFilter?data.goodTasks.filter(t=>myIds.includes(t.id)):data.goodTasks;
  const filtBad  = hasFilter?data.badTasks.filter(t=>myIds.includes(t.id)):data.badTasks;
  const sortTaskFn = (a,b) =>
    taskSort==="pts_high"?Math.abs(taskPts(b,child.id))-Math.abs(taskPts(a,child.id)):
    taskSort==="pts_low"?Math.abs(taskPts(a,child.id))-Math.abs(taskPts(b,child.id)):
    taskSort==="name"?a.label.localeCompare(b.label,"ja"):0;

  // 5-tab grouped nav
  const MAIN_TABS = isJunior
    ? [["daily","📋 まいにち"],["tasks","✅ やること"],["goals","🌱 ためる"]]
    : [["daily","毎日"],["activity","活動"],["money","ためる"],["learn","学ぶ"],["more","記録"]];
  // 新タブ体系マッピング（旧→新）
  const tabAlias = {
    tasks:"activity", invest:"activity", kakeibo:"money",
    goals:"money", rewards:"money", log:"more",
    badges:"more", tips:"more", ranking:"more", gacha:"daily"
  };
  const effectiveTab = tabAlias[tab] || tab;
  const darkBG = !isJunior; // teen/adultはダークモード

  return (
    <div style={{minHeight:"100vh",background:darkBG?"#040810":BG,fontFamily:F,paddingBottom:80}}>
      {/* ヒーローエリア */}
      {isJunior ? (()=>{
        const h=new Date().getHours();
        const bg=h>=7&&h<11
          ?"linear-gradient(180deg,#1a0a00 0%,#7c2d00 25%,#c2612a 50%,#e8a06a 70%,#2d6a3a 100%)"
          :h>=11&&h<17
          ?"linear-gradient(180deg,#0a2a4a 0%,#1a5c8a 30%,#2a8a5a 65%,#1f7038 100%)"
          :h>=17&&h<20
          ?"linear-gradient(180deg,#1a0a20 0%,#6b2d00 20%,#c25a1a 45%,#7b3a8a 65%,#1a4a28 100%)"
          :h>=20&&h<22
          ?"linear-gradient(180deg,#050d1a 0%,#0a1a30 35%,#0d2a1a 65%,#164a28 100%)"
          :"linear-gradient(180deg,#020508 0%,#050d10 40%,#0a1a10 70%,#0f3020 100%)";
        const starOpacity=h>=7&&h<17?0.2:0.6;
        return(
      <div style={{background:bg,position:"relative",overflow:"hidden",paddingBottom:0}}>
        {[[10,15],[25,8],[70,12],[85,6],[50,22],[38,4],[62,18],[15,30]].map(([l,t],i)=>(
          <div key={i} style={{position:"absolute",top:`${t}%`,left:`${l}%`,width:i%3===0?3:2,height:i%3===0?3:2,borderRadius:"50%",background:"#fff",opacity:(starOpacity+i*0.03),animation:`twinkle ${1.4+i*0.25}s ease-in-out infinite alternate`,pointerEvents:"none"}}/>
        ))}
        <div style={{position:"absolute",bottom:60,left:0,right:0,height:50,pointerEvents:"none"}}>
          {[[5,40],[15,55],[82,48],[92,38]].map(([l,h],i)=>(
            <div key={i} style={{position:"absolute",bottom:0,left:`${l}%`,width:18,height:h,background:"#0d2a14",borderRadius:"50% 50% 0 0"}}/>
          ))}
        </div>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:36,background:"linear-gradient(0deg,#1a5c30 0%,#1f7038 60%,transparent 100%)",pointerEvents:"none"}}/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 20px 0",position:"relative",zIndex:2}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.12)",border:"1.5px solid rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,color:"#fff"}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:14,color:"rgba(255,255,255,0.9)",letterSpacing:0.5}}>Tane Money</div>
          <button onClick={()=>setShowSettings(true)} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.12)",border:"1.5px solid rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:"#fff",position:"relative"}}>
            ⚙
            {(data.pendingApprovals||[]).length>0&&(<div style={{position:"absolute",top:-5,right:-5,minWidth:17,height:17,borderRadius:999,background:R,color:"#fff",fontSize:9,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px",lineHeight:1}}>{(data.pendingApprovals||[]).length}</div>)}
          </button>
        </div>
        <div style={{textAlign:"center",position:"relative",zIndex:2,padding:"16px 0 4px"}}>
          <SeedMonster child={child} data={data} size={130} update={update}/>
        </div>
        <div style={{position:"relative",zIndex:2,margin:"0 16px",background:"rgba(255,255,255,0.12)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderRadius:"18px 18px 0 0",border:"1px solid rgba(255,255,255,0.18)",borderBottom:"none",padding:"14px 18px 16px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{color:"rgba(255,255,255,0.65)",fontSize:11,fontWeight:600,marginBottom:2}}>{child.emoji} {child.name}</div>
              <div style={{display:"flex",alignItems:"flex-end",gap:5}}>
                <span style={{color:"#fff",fontSize:30,fontWeight:900,lineHeight:1,letterSpacing:-1}}>{myBal.toLocaleString()}</span>
                <span style={{color:"rgba(255,255,255,0.7)",fontSize:12,fontWeight:600,marginBottom:3}}>pt</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.55)"}}>今月</span>
                <span style={{fontSize:12,fontWeight:700,color:monthDelta>=0?"#86efac":"#fca5a5"}}>{monthDelta>=0?"+":""}{monthDelta.toLocaleString()}pt</span>
                {curStreak>=3&&<span style={{fontSize:11,background:"rgba(255,200,0,0.2)",color:"#fde68a",padding:"2px 7px",borderRadius:999,fontWeight:700}}>🔥 {curStreak}日</span>}
              </div>
            </div>
            <button onClick={()=>setShowTransfer(true)} style={{background:"rgba(255,255,255,0.18)",border:"1.5px solid rgba(255,255,255,0.3)",borderRadius:12,padding:"8px 14px",color:"#fff",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:F}}>💸 おくる</button>
          </div>
        </div>
        <style>{`@keyframes twinkle{0%{opacity:0.3;transform:scale(1)}100%{opacity:0.9;transform:scale(1.4)}}`}</style>
      </div>
        );
      })() : (()=>{
        // Teen: ダークダッシュボード
        const ttd=(data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")).length;
        const myBadges=(data.logs||[]).filter(l=>l.cid===child.id&&l.type==="badge").length;
        const stocks2=data.stocks||[];
        const myH2=(data.holdings||{})[child.id]||[];
        const toPts2=(s,p)=>s.currency==="USD"?Math.max(1,Math.round(p*1.5)):Math.max(1,Math.round(p/100));
        const portV2=myH2.reduce((s,h)=>{const st=stocks2.find(x=>x.id===h.stockId);return s+(st?toPts2(st,st.price)*h.qty:0);},0);
        return(
      <div style={{background:"linear-gradient(160deg,#060d1a 0%,#0f1a2e 50%,#091220 100%)",position:"relative",overflow:"hidden"}}>
        {/* 背景グリッド */}
        <div style={{position:"absolute",inset:0,backgroundImage:"linear-gradient(rgba(74,158,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(74,158,255,0.04) 1px,transparent 1px)",backgroundSize:"32px 32px",pointerEvents:"none"}}/>
        {/* アクセントライン */}
        <div style={{position:"absolute",top:0,left:"10%",right:"10%",height:1,background:"linear-gradient(90deg,transparent,rgba(74,158,255,0.4),transparent)",pointerEvents:"none"}}/>
        {/* トップバー */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 20px 0",position:"relative",zIndex:2}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,color:"#e2e8f0"}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:12,color:"rgba(74,158,255,0.7)",letterSpacing:2,textTransform:"uppercase"}}>Tane Money</div>
          <button onClick={()=>setShowSettings(true)} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:"#e2e8f0",position:"relative"}}>
            ⚙
            {(data.pendingApprovals||[]).length>0&&(<div style={{position:"absolute",top:-5,right:-5,minWidth:17,height:17,borderRadius:999,background:"#ef4444",color:"#fff",fontSize:9,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px",lineHeight:1}}>{(data.pendingApprovals||[]).length}</div>)}
          </button>
        </div>
        {/* 残高表示 */}
        <div style={{padding:"20px 20px 0",position:"relative",zIndex:2}}>
          <div style={{color:"rgba(255,255,255,0.38)",fontSize:11,fontWeight:700,marginBottom:4,letterSpacing:0.5}}>{child.emoji} {child.name}</div>
          <div style={{display:"flex",alignItems:"flex-end",gap:8,marginBottom:2}}>
            <span style={{color:"#fff",fontSize:38,fontWeight:900,lineHeight:1,letterSpacing:-2}}>{myBal.toLocaleString()}</span>
            <span style={{color:"#4a9eff",fontSize:15,fontWeight:700,marginBottom:5}}>pt</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
            <span style={{color:"rgba(255,255,255,0.3)",fontSize:11}}>今月</span>
            <span style={{fontWeight:700,fontSize:12,color:monthDelta>=0?"#4ade80":"#f87171"}}>{monthDelta>=0?"+":""}{monthDelta.toLocaleString()}pt</span>
            <button onClick={()=>setShowTransfer(true)} style={{marginLeft:"auto",background:"rgba(74,158,255,0.12)",border:"1px solid rgba(74,158,255,0.25)",borderRadius:10,padding:"5px 13px",color:"#4a9eff",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F}}>💸 おくる</button>
          </div>
        </div>
        {/* 4ステータスグリッド */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,padding:"0 20px 24px",position:"relative",zIndex:2}}>
          {[
            ["🔥","連続",curStreak>0?`${curStreak}日`:null,"#fde68a","daily","毎日開こう"],
            ["⚡","タスク",ttd>0?`${ttd}回`:null,"#a78bfa","activity","タスクをやろう"],
            ["📊","ポートフォリオ",portV2>0?`${portV2.toLocaleString()}pt`:null,"#4ade80","activity","株を買おう"],
            ["🏅","バッジ",myBadges>0?`${myBadges}個`:null,"#fbbf24","more","実績を稼ごう"],
          ].map(([e,l,v,c,tabTarget,hint])=>(
            <div key={l} onClick={()=>{if(!v)setTab(tabTarget);}}
              style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${!v?"rgba(74,158,255,0.15)":"rgba(255,255,255,0.07)"}`,borderRadius:14,padding:"12px 14px",cursor:!v?"pointer":"default",transition:"background .15s"}}>
              <div style={{fontSize:18,marginBottom:3}}>{e}</div>
              <div style={{color:"rgba(255,255,255,0.35)",fontSize:9,fontWeight:700,letterSpacing:0.5,marginBottom:3}}>{l}</div>
              {v ? (
                <div style={{color:c,fontSize:17,fontWeight:900}}>{v}</div>
              ) : (
                <div style={{color:"rgba(74,158,255,0.6)",fontSize:10,lineHeight:1.4}}>{hint} →</div>
              )}
            </div>
          ))}
        </div>
      </div>
        );
      })()}
      {/* タブナビゲーション */}
      <div style={{display:"flex",background:isJunior?CARD:"#0f1a2e",borderBottom:isJunior?`1px solid ${BORDER}`:"1px solid rgba(74,158,255,0.12)",overflowX:"auto",scrollbarWidth:"none",position:"sticky",top:0,zIndex:100,boxShadow:isJunior?"0 2px 8px rgba(24,35,29,0.04)":"0 2px 12px rgba(0,0,0,0.4)"}}>
        {MAIN_TABS.map(([v,l])=>(
          <button key={v} onClick={()=>setTab(v)}
            style={{flex:1,padding:"7px 4px 7px",border:"none",borderBottom:effectiveTab===v?`2.5px solid ${isJunior?GP:"#4a9eff"}`:"2.5px solid transparent",background:"none",color:effectiveTab===v?(isJunior?GP:"#4a9eff"):(isJunior?MUTED:"rgba(255,255,255,0.35)"),fontWeight:effectiveTab===v?700:500,fontSize:10,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap",minWidth:56,transition:"all .15s",display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
            <img src={`/assets/tab_${v}.png`} alt="" style={{width:22,height:22,objectFit:"contain",opacity:effectiveTab===v?1:0.4,filter:(!isJunior&&effectiveTab!==v)?"brightness(0.6)":"none",transition:"opacity .15s"}}/>
            {l.replace(/^\S+\s+/,"")}
          </button>
        ))}
      </div>

      {/* ── ストリーク消滅リマインダー ── */}
      {curStreak>=3 && !todayTaskDone && effectiveTab==="daily" && (
        <div style={{margin:"10px 16px 0",background:`linear-gradient(135deg,#fff8e1,#fffde7)`,border:`2px solid ${GOLD}`,borderRadius:14,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:24}}>🔥</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:13,color:"#b45309"}}>連続{curStreak}日！今日もタスクをやろう</div>
            <div style={{fontSize:11,color:MUTED,marginTop:1}}>タスクを完了しないと記録が途切れるよ</div>
          </div>
        </div>
      )}

      {/* ── 学ぶ（Teenモード） ── */}
      {effectiveTab==="learn" && !isJunior && (
        <TipsSection ageMode={child.ageMode||"middle"} child={child} data={data} update={update}/>
      )}

      {/* ── 家族ミッション導線（ホームタブ内の小カード） ── */}
      {effectiveTab==="daily" && (()=>{
        const fs=data.familySettings||INIT.familySettings;
        if(!fs.familyMission?.enabled) return null;
        const missionPts=(data.logs||[]).filter(l=>["daily","good","bad"].includes(l.type)&&l.pts>0).reduce((s,l)=>s+l.pts,0);
        const target=fs.familyMission?.target||3000;
        const pct=Math.min(100,Math.floor(missionPts/target*100));
        return(
          <div style={{padding:"0 16px 12px"}}>
            <div style={{background:CARD,borderRadius:14,padding:"12px 14px",border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",gap:10,boxShadow:"0 2px 8px rgba(24,35,29,0.04)"}}>
              <span style={{fontSize:14}}>❤</span>
              <div style={{flex:1}}>
                <div style={{fontSize:12,fontWeight:700,color:TEXT}}>家族ミッション</div>
                <div style={{fontSize:11,color:MUTED}}>みんなであと{(target-missionPts).toLocaleString()}pt</div>
                <div style={{background:BORDER,borderRadius:999,height:4,marginTop:5,overflow:"hidden"}}>
                  <div style={{width:`${pct}%`,height:"100%",background:G,borderRadius:999}}/>
                </div>
              </div>
              <div style={{fontSize:11,fontWeight:700,color:GP}}>{pct}%</div>
            </div>
          </div>
        );
      })()}

      {/* Modals */}
      {showTransfer&&<PointTransferModal child={child} data={data} update={update} onClose={()=>setShowTransfer(false)}/>}
      {showWeekly&&<WeeklyReport child={child} data={data} onClose={()=>setShowWeekly(false)}/>}
      {showCustomizer&&<TaskCustomizer child={child} data={data} update={update} onClose={()=>setShowCustomizer(false)}/>}
      {goalCelebration&&<GoalCelebration goal={goalCelebration} onClose={()=>setGoalCelebration(null)}/>}

      {/* Flash */}
      {flash && (
        <div style={{position:"fixed",top:"28%",left:"50%",transform:"translate(-50%,-50%)",background:flash.pending?GOLD:flash.pts>=0?G:R,color:"#fff",borderRadius:20,padding:"14px 26px",zIndex:900,textAlign:"center",boxShadow:"0 8px 30px #0003",animation:"popIn .3s ease"}}>
          <div style={{fontSize:38}}>{flash.emoji}</div>
          {flash.pending
            ? <div style={{fontSize:12,fontWeight:700,marginTop:4}}>おうちの人に確認するね</div>
            : <Pt v={flash.pts} sz={22}/>
          }
        </div>
      )}

      {/* Gacha anim */}
      {gachaRes && <GachaAnim result={gachaRes} onClose={()=>setGachaRes(null)}/>}

      {/* Reward confirm */}
      {rewardPop && (
        <div style={{position:"fixed",inset:0,background:"#0008",zIndex:800,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:CARD,borderRadius:24,padding:28,width:"100%",maxWidth:320,textAlign:"center",fontFamily:F}}>
            <div style={{fontSize:52}}>{rewardPop.emoji}</div>
            <h3 style={{fontWeight:900,fontSize:18,margin:"8px 0 4px"}}>{rewardPop.label}</h3>
            <p style={{color:MUTED,fontSize:13,margin:"0 0 14px"}}>{rewardPop.unit}</p>
            <div style={{background:BG,borderRadius:12,padding:"10px 14px",marginBottom:16}}>
              <p style={{fontWeight:800,fontSize:16,margin:0}}>{rewardPop.cost.toLocaleString()}pt つかう</p>
              {myBal >= rewardPop.cost
                ? <p style={{color:MUTED,fontSize:12,margin:"4px 0 0"}}>残高: {myBal.toLocaleString()}pt → <span style={{color:G,fontWeight:800}}>{(myBal-rewardPop.cost).toLocaleString()}pt</span></p>
                : <p style={{color:R,fontWeight:700,fontSize:13,margin:"4px 0 0"}}>残高がたりないよ</p>}
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setRewardPop(null)} style={{flex:1,background:BORDER,border:"none",borderRadius:12,padding:12,fontWeight:800,color:MUTED,cursor:"pointer",fontFamily:F}}>やめる</button>
              {myBal>=rewardPop.cost && <button onClick={()=>doRedeem(rewardPop)} style={{flex:1,background:Y,border:"none",borderRadius:12,padding:12,fontWeight:900,color:TEXT,cursor:"pointer",fontFamily:F}}>こうかん🎉</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── DAILY ── */}
      {effectiveTab==="daily" && <>
        {/* Teen: タスクを先に表示（ガチャより優先） */}
        {!isJunior && <>
          <div style={{color:"rgba(255,255,255,0.25)",fontSize:10,fontWeight:700,letterSpacing:1.5,padding:"14px 16px 0"}}>TODAY'S TASKS</div>
          <TabHint id="daily" text="今日のタスクをやってポイントをゲット！連続記録でボーナスも🌟" data={data} update={update} cid={child.id}/>
          <DailyTasks child={child} data={data} update={update}/>
        </>}
        {/* ── デイリーガチャ（Junior: 最上部 / Teen: タスクの下） ── */}
        <div style={{padding:"12px 16px 4px"}}>
          {!isJunior&&<div style={{color:"rgba(255,255,255,0.3)",fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8}}>🎰 DAILY GACHA</div>}
          {(()=>{
            const mTheme=getMonthTheme();
            const bonusLabel=curStreak>=30?"+50pt":curStreak>=10?"+20pt":curStreak>=5?"+10pt":null;
            const monthGacha=myLogs.filter(l=>l.type==="gacha"&&(l.date||"").startsWith(monthKey()));
            const tierCounts=(data.gacha||[]).map(tier=>({...tier,count:monthGacha.filter(l=>l.tierId===tier.id||(l.label||"").includes(tier.label)).length}));
            return(<>
              <div style={{background:darkBG?(todayDone?"rgba(255,255,255,0.05)":"rgba(255,255,255,0.07)"):(todayDone?CARD:`linear-gradient(135deg,${mTheme.bg},#fffbe6)`),border:darkBG?`1px solid ${todayDone?"rgba(255,255,255,0.1)":mTheme.color+"50"}`:`2px solid ${todayDone?BORDER:mTheme.color}`,borderRadius:20,padding:"16px 18px",display:"flex",alignItems:"center",gap:14}}>
                <button onClick={doGacha} disabled={todayDone}
                  style={{width:62,height:62,borderRadius:"50%",border:"none",flexShrink:0,
                    background:todayDone?"radial-gradient(circle at 35% 35%,#ccc,#aaa)":`radial-gradient(circle at 35% 35%,${mTheme.bg},${mTheme.color})`,
                    fontSize:28,cursor:todayDone?"default":"pointer",
                    boxShadow:todayDone?"none":`0 4px 16px ${mTheme.color}60`,
                    animation:todayDone?"none":"glow 2s ease-in-out infinite"}}>
                  {mTheme.emoji}
                </button>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:mTheme.color,fontWeight:700,marginBottom:2}}>{mTheme.emoji} {mTheme.name}ガチャ</div>
                  <div style={{fontWeight:800,fontSize:14,color:darkBG?(todayDone?"rgba(255,255,255,0.35)":"#fff"):(todayDone?MUTED:TEXT)}}>
                    {todayDone?(darkBG?"CLAIMED":"✅ 今日は引き済み！"):"デイリーガチャ"}
                  </div>
                  <div style={{fontSize:12,color:darkBG?"rgba(255,255,255,0.3)":MUTED,marginTop:2}}>
                    {todayDone?(darkBG?"BACK TOMORROW":"また明日ね🌙"):`1日1回 · 最大${Math.max(...(data.gacha||[]).map(g=>g.max))}pt`}
                  </div>
                  {bonusLabel&&!todayDone&&<div style={{marginTop:4,fontSize:11,color:R,fontWeight:700}}>🔥 {curStreak}連続ボーナス {bonusLabel}！</div>}
                  {!bonusLabel&&curStreak>=3&&!todayDone&&<div style={{marginTop:4,fontSize:11,color:R,fontWeight:700}}>🔥 {curStreak}日連続中！</div>}
                </div>
                {!todayDone&&<div style={{fontSize:11,background:mTheme.bg,color:mTheme.color,padding:"4px 10px",borderRadius:999,fontWeight:700,flexShrink:0,border:`1px solid ${mTheme.color}40`}}>TAP！</div>}
              </div>
              {monthGacha.length>0&&(
                <div style={{marginTop:8,display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                  <span style={{fontSize:10,color:darkBG?"rgba(255,255,255,0.45)":MUTED,fontWeight:600}}>今月:</span>
                  {tierCounts.filter(t=>t.count>0).map(t=>(
                    <span key={t.id} style={{fontSize:10,background:darkBG?"rgba(255,255,255,0.06)":CARD,border:`1px solid ${t.color}50`,borderRadius:999,padding:"2px 8px",color:t.color,fontWeight:700}}>{t.emoji}×{t.count}</span>
                  ))}
                </div>
              )}
              {/* 図鑑 */}
              {(()=>{
                const coll=data.gachaCollection?.[child.id]||{};
                const zukanCount=GACHA_ITEMS.filter(i=>coll[i.id]>0).length;
                const tierColorMap=Object.fromEntries((data.gacha||[]).map(g=>[g.id,g.color]));
                return(<div style={{marginTop:10}}>
                  <button onClick={()=>setShowZukan(v=>!v)} style={{width:"100%",background:darkBG?"rgba(255,255,255,0.05)":CARDS,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderRadius:showZukan?"14px 14px 0 0":14,padding:"9px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",fontFamily:F}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:15}}>📖</span>
                      <span style={{fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.8)":TEXT}}>図鑑</span>
                      <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.3)":MUTED}}>{zukanCount}/{GACHA_ITEMS.length}コンプリート</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{height:5,width:60,background:BORDER,borderRadius:999,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${zukanCount/GACHA_ITEMS.length*100}%`,background:G,borderRadius:999}}/>
                      </div>
                      <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.3)":MUTED}}>{showZukan?"▲":"▼"}</span>
                    </div>
                  </button>
                  {showZukan&&(
                    <div style={{background:darkBG?"rgba(255,255,255,0.04)":CARDS,borderRadius:"0 0 14px 14px",padding:"10px",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderTop:"none"}}>
                      {GACHA_ITEMS.map(item=>{
                        const cnt=coll[item.id]||0;
                        const tc=tierColorMap[item.tierId]||BORDER;
                        return(<div key={item.id} style={{textAlign:"center",background:cnt>0?(darkBG?"rgba(255,255,255,0.08)":CARD):(darkBG?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.04)"),borderRadius:11,padding:"8px 3px",border:`1.5px solid ${cnt>0?tc:(darkBG?"rgba(255,255,255,0.1)":BORDER)}`,transition:"all .2s"}}>
                          {cnt>0
                            ? <img src={`/assets/${item.id.replace("gi_","gacha_")}.png`} alt={item.name} style={{width:38,height:38,objectFit:"contain",borderRadius:6,display:"block",margin:"0 auto"}}/>
                            : <div style={{fontSize:22,opacity:0.3}}>❓</div>
                          }
                          <div style={{fontSize:8,fontWeight:700,color:cnt>0?(darkBG?"rgba(255,255,255,0.8)":TEXT):MUTED,marginTop:3,lineHeight:1.3}}>{cnt>0?item.name:"???"}</div>
                          {cnt>1&&<div style={{fontSize:7,color:MUTED}}>×{cnt}</div>}
                        </div>);
                      })}
                    </div>
                  )}
                </div>);
              })()}
            </>);
          })()}
          <style>{`@keyframes glow{0%,100%{box-shadow:0 4px 16px #f5c84260,0 0 0 4px #f5c84225}50%{box-shadow:0 4px 24px #f5c84290,0 0 0 8px #f5c84240}}`}</style>
        </div>
        {/* Junior: タスクはガチャの後 */}
        {isJunior && <>
          <TabHint id="daily" text="毎日タスクをチェックしよう！全部クリアするとボーナスポイントがもらえるよ🌟" data={data} update={update} cid={child.id}/>
          <DailyTasks child={child} data={data} update={update}/>
          {/* やることへのショートカット */}
          <div style={{padding:"8px 16px 4px"}}>
            <button onClick={()=>setTab("tasks")}
              style={{width:"100%",background:`linear-gradient(135deg,${GS},#fff)`,border:`2px solid ${G}`,borderRadius:20,padding:"16px 20px",cursor:"pointer",display:"flex",alignItems:"center",gap:14,fontFamily:F,textAlign:"left",boxShadow:SHADOW}}>
              <span style={{fontSize:36}}>✅</span>
              <div>
                <div style={{fontWeight:900,fontSize:16,color:GP}}>きょうのやること</div>
                <div style={{fontSize:12,color:TEXTS,marginTop:2}}>タップしてポイントをもらおう！</div>
              </div>
              <span style={{marginLeft:"auto",fontSize:24,color:G}}>›</span>
            </button>
          </div>
          {/* さいきんのきろく */}
          {myLogs.length>0&&(
            <div style={{padding:"8px 16px 16px"}}>
              <div style={{fontWeight:800,fontSize:13,color:MUTED,marginBottom:8}}>📋 さいきんのきろく</div>
              {[...myLogs].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,3).map(l=>{
                const emoji=l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":l.type==="transfer_in"?"💌":l.type==="transfer_out"?"💸":"⭐";
                return(
                  <div key={l.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"11px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:22}}>{emoji}</span>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{l.label}</div>
                      <div style={{color:MUTED,fontSize:10}}>{fmtDate(l.date)}</div>
                    </div>
                    <Pt v={l.pts}/>
                  </div>
                );
              })}
            </div>
          )}
        </>}
      </>}

      {/* ── ACTIVITY サブナビ ── */}
      {effectiveTab==="activity"&&!isJunior&&!young&&(
        <div style={{display:"flex",background:darkBG?"#0f1a2e":CARD,borderBottom:`1px solid ${darkBG?"rgba(74,158,255,0.15)":BORDER}`}}>
          {[["tasks","✅ タスク"],["invest","📈 投資/為替"]].map(([v,l])=>(
            <button key={v} onClick={()=>setActTab(v)}
              style={{flex:1,padding:"10px 0",border:"none",borderBottom:actTab===v?`2.5px solid ${darkBG?"#4a9eff":GP}`:"2.5px solid transparent",background:"none",color:actTab===v?(darkBG?"#4a9eff":GP):(darkBG?"rgba(255,255,255,0.4)":MUTED),fontWeight:actTab===v?700:500,fontSize:12,cursor:"pointer",fontFamily:F}}>
              {l}
            </button>
          ))}
        </div>
      )}

      {/* ── ACTIVITY ── */}
      {effectiveTab==="activity"&&(actTab==="tasks"||young)&&(()=>{
        return(<div style={{padding:16}}>
          <TabHint id="tasks" text="やったお手伝いをタップして記録しよう！✏リスト編集で自分用のタスクを選べるよ" data={data} update={update} cid={child.id}/>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
            <div style={{flex:1}}><SortBar options={[["default","デフォルト"],["pts_high","pt高い順"],["pts_low","pt低い順"],["name","名前順"]]} value={taskSort} onChange={setTaskSort}/></div>
            <button onClick={()=>setShowCustomizer(true)} style={{flexShrink:0,padding:"5px 11px",border:`1.5px solid ${hasFilter?G:BORDER}`,borderRadius:20,background:hasFilter?`${G}15`:"transparent",color:hasFilter?G:MUTED,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
              {hasFilter?`✏ ${myIds.length}個選択中`:"✏ リスト編集"}
            </button>
          </div>
          {filtGood.length>0&&<>
            <p style={{color:MUTED,fontSize:12,fontWeight:700,marginBottom:10}}>✅ {young?"いいこと":"いいこと（プラス）"}</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
              {[...filtGood].sort(sortTaskFn).map(t=>{const pts=taskPts(t,child.id);const on=!!pressed[t.id];const isPending=(data.pendingApprovals||[]).some(p=>p.cid===child.id&&p.taskId===t.id);const isDone=doneTodayIds.has(t.id);return(<button key={t.id} onClick={()=>doTask(t)} style={{background:isDone?CARDS:isPending?GOLDS:on?"#e8faf0":CARD,border:`2.5px solid ${isDone?BORDER:isPending?GOLD:on?G:BORDER}`,borderRadius:18,padding:"13px 10px",cursor:isDone?"default":"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6,transform:on?"scale(.92)":"scale(1)",transition:"all .2s",fontFamily:F,position:"relative",opacity:isDone?0.6:1}}>{isDone&&<div style={{position:"absolute",top:4,right:4,fontSize:9,background:G,color:"#fff",borderRadius:999,padding:"1px 5px",fontWeight:700}}>✓ 完了</div>}{isPending&&!isDone&&<div style={{position:"absolute",top:4,right:4,fontSize:9,background:GOLD,color:"#fff",borderRadius:999,padding:"1px 5px",fontWeight:700}}>確認待ち</div>}<span style={{fontSize:young?34:26}}>{t.emoji}</span><span style={{fontSize:young?15:12,fontWeight:700,color:TEXT,textAlign:"center"}}>{t.label}</span>{!young&&<Pt v={pts} sz={12}/>}</button>);})}
            </div>
          </>}
          {!young&&filtBad.length>0&&<>
            <div style={{display:"flex",alignItems:"center",gap:8,margin:"18px 0 10px"}}>
              <div style={{flex:1,height:1,background:RS}}/>
              <span style={{fontSize:11,fontWeight:700,color:R,padding:"3px 10px",background:RS,borderRadius:999}}>❌ わるいこと（マイナス）</span>
              <div style={{flex:1,height:1,background:RS}}/>
            </div>
            <div style={{background:`${R}08`,border:`1.5px dashed ${RS}`,borderRadius:14,padding:"10px 10px 4px",marginBottom:4}}>
              <p style={{margin:"0 0 8px",fontSize:11,color:R,fontWeight:600}}>やってしまったら正直に記録しよう</p>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[...filtBad].sort(sortTaskFn).map(t=>{const on=!!pressed[t.id];return(<button key={t.id} onClick={()=>doTask(t)} style={{background:on?"#fef0ef":CARD,border:`2.5px solid ${on?R:BORDER}`,borderRadius:18,padding:"13px 10px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6,transform:on?"scale(.92)":"scale(1)",transition:"all .2s",fontFamily:F}}><span style={{fontSize:26}}>{t.emoji}</span><span style={{fontSize:12,fontWeight:700,color:TEXT,textAlign:"center"}}>{t.label}</span><Pt v={taskPts(t,child.id)} sz={12}/></button>);})}</div>
            </div>
          </>}
          {filtGood.length===0&&filtBad.length===0&&(
            <div style={{textAlign:"center",padding:"32px 16px"}}>
              {(data.goodTasks||[]).length>0
                ?<><div style={{fontSize:40,marginBottom:12}}>✅</div><p style={{fontWeight:800,fontSize:15,color:TEXT,margin:"0 0 8px"}}>やることリストを作ろう！</p><p style={{color:MUTED,fontSize:12,margin:"0 0 16px"}}>お手伝いの中から好きなものを選んでね</p><button onClick={()=>setShowCustomizer(true)} style={{background:G,border:"none",borderRadius:12,padding:"12px 28px",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:F}}>リストを選ぶ →</button></>
                :<><div style={{fontSize:40,marginBottom:12}}>📋</div><p style={{fontWeight:800,fontSize:15,color:TEXT,margin:"0 0 8px"}}>お手伝いが登録されていないよ</p><p style={{color:MUTED,fontSize:12}}>🔐 おや管理からタスクを追加してもらおう！</p></>
              }
            </div>
          )}
        </div>);
      })()}
      {effectiveTab==="activity"&&actTab==="invest"&&!young&&<InvestTab child={child} data={data} update={update}/>}
      {/* ── KAKEIBO ── */}
      {effectiveTab==="money" && (
        <div style={{padding:"12px 16px 0",display:"flex",gap:6}}>
          {(isJunior
            ?[["goals","🎯 もくひょう"],["rewards","🎁 こうかん"]]
            :[["goals","🎯 目標"],["rewards","🎁 こうかん"],["kakeibo","📒 家計簿"]]
          ).map(([k,l])=>(
            <button key={k} onClick={()=>setMonTab(k)}
              style={{flex:1,padding:"8px 0",border:"none",borderRadius:10,
                background:monTab===k?GP:"transparent",
                color:monTab===k?"#fff":MUTED,
                fontWeight:monTab===k?700:400,fontSize:12,cursor:"pointer",fontFamily:F}}>
              {l}
            </button>
          ))}
        </div>
      )}
      {effectiveTab==="money" && monTab==="kakeibo" && (
        <div>
          {/* month nav */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px",background:CARD,borderBottom:`1px solid ${BORDER}`}}>
            <button onClick={()=>{const d=new Date(kMonth+"-01");d.setMonth(d.getMonth()-1);setKMonth(monthKey(d));}} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>‹</button>
            <span style={{fontWeight:800,fontSize:15}}>{(()=>{const d=new Date(kMonth+"-01");return `${d.getFullYear()}年${d.getMonth()+1}月`;})()}</span>
            <button onClick={()=>{const d=new Date(kMonth+"-01");d.setMonth(d.getMonth()+1);if(monthKey(d)<=monthKey())setKMonth(monthKey(d));}} disabled={kMonth>=monthKey()} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:kMonth>=monthKey()?BORDER:MUTED}}>›</button>
          </div>
          {/* summary */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,padding:"12px 16px"}}>
            <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"11px 13px"}}><div style={{color:MUTED,fontSize:11,fontWeight:700}}>今月の支出</div><div style={{color:R,fontWeight:900,fontSize:20}}>{kTotal.toLocaleString()}pt</div></div>
            <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"11px 13px"}}><div style={{color:MUTED,fontSize:11,fontWeight:700}}>生涯の支出</div><div style={{color:TEXT,fontWeight:900,fontSize:20}}>{kLife.toLocaleString()}pt</div></div>
          </div>
          {/* controls */}
          <div style={{display:"flex",gap:8,padding:"0 16px 12px",alignItems:"center"}}>
            <div style={{display:"flex",flex:1,background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:10,overflow:"hidden"}}>
              {[["graph","📊 グラフ"],["list","📋 一覧"]].map(([v,l])=>(
                <button key={v} onClick={()=>setKTab(v)} style={{flex:1,padding:"8px 0",border:"none",background:kTab===v?TEXT:"transparent",color:kTab===v?"#fff":MUTED,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>{l}</button>
              ))}
            </div>
            <Btn c={R} label="＋ 記録" onClick={()=>setKAdd(s=>!s)}/>
          </div>
          {/* add form */}
          {kAdd && (
            <div style={{margin:"0 16px 14px",background:`${R}10`,border:`2px dashed ${R}`,borderRadius:16,padding:14}}>
              <p style={{fontWeight:800,fontSize:13,color:R,margin:"0 0 10px"}}>💸 支出を記録</p>
              <select value={kForm.catId} onChange={e=>setKForm(f=>({...f,catId:e.target.value}))} style={{...INP,marginBottom:8}}>
                {(data.cats||[]).map(c=><option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
              </select>
              <input value={kForm.label} onChange={e=>setKForm(f=>({...f,label:e.target.value}))} placeholder="内容（例: マックのハンバーガー）" style={{...INP,marginBottom:8}}/>
              <input value={kForm.amt} onChange={e=>setKForm(f=>({...f,amt:e.target.value}))} type="number" placeholder="金額（pt）" style={{...INP,marginBottom:10}}/>
              <div style={{display:"flex",gap:8}}><Btn c={R} label="記録する" onClick={addExpense} disabled={!kForm.label||!kForm.amt}/><Btn c={MUTED} label="キャンセル" onClick={()=>setKAdd(false)}/></div>
            </div>
          )}
          {/* graph */}
          {kTab==="graph" && (
            <div style={{padding:"0 16px"}}>
              {kCatData.length===0
                ? <p style={{color:MUTED,textAlign:"center",marginTop:32,fontSize:13}}>この月はまだ記録がないよ</p>
                : <>
                    <div style={{display:"flex",gap:14,alignItems:"center",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:18,padding:16,marginBottom:12}}>
                      <Pie data={kCatData} size={130}/>
                      <div style={{flex:1}}>
                        {kCatData.map(c=>(
                          <div key={c.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                            <div style={{width:9,height:9,borderRadius:"50%",background:c.color,flexShrink:0}}/>
                            <span style={{fontSize:11,fontWeight:700,flex:1}}>{c.emoji} {c.label}</span>
                            <span style={{fontSize:11,color:c.color,fontWeight:800}}>{Math.round(c.v/kTotal*100)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:18,padding:16,marginBottom:12}}>
                      <p style={{fontWeight:800,fontSize:12,color:MUTED,margin:"0 0 10px"}}>カテゴリ別</p>
                      {kCatData.map(c=>(
                        <div key={c.id} style={{marginBottom:9}}>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:700,marginBottom:3}}><span>{c.emoji} {c.label}</span><span style={{color:c.color}}>{c.v.toLocaleString()}pt</span></div>
                          <div style={{height:9,background:BORDER,borderRadius:5,overflow:"hidden"}}><div style={{height:"100%",width:`${c.v/kMax*100}%`,background:c.color,borderRadius:5,transition:"width .5s"}}/></div>
                        </div>
                      ))}
                    </div>
                    <div style={{background:"#fef9e0",border:`1.5px solid ${Y}`,borderRadius:14,padding:14,marginBottom:12}}>
                      <p style={{margin:0,fontSize:13,fontWeight:700,lineHeight:1.6}}>
                        💡 今月は <span style={{color:kCatData[0].color,fontWeight:900}}>「{kCatData[0].label}」</span> に一番使ったよ！（{kCatData[0].total||kCatData[0].v}pt）
                        {kCatData[0].v/kTotal>0.5 && <><br/><span style={{color:R}}>⚠ 支出の半分以上が集中してるよ！</span></>}
                      </p>
                    </div>
                  </>
              }
            </div>
          )}
          {/* list */}
          {kTab==="list" && (
            <div style={{padding:"0 16px"}}>
              {[...kExps].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>{
                const cat=(data.cats||[]).find(c=>c.id===e.catId)||INIT.cats[5];
                return (
                  <div key={e.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"10px 13px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:34,height:34,borderRadius:9,background:`${cat.color}20`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>{cat.emoji}</div>
                    <div style={{flex:1,minWidth:0}}><div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.label}</div><div style={{color:MUTED,fontSize:10}}>{cat.label} · {fmtDate(e.date)}</div></div>
                    <span style={{fontWeight:900,fontSize:14,color:R,flexShrink:0}}>-{e.amt.toLocaleString()}pt</span>
                    <button onClick={()=>delExpense(e.id)} style={{background:"none",border:"none",color:MUTED,fontSize:15,cursor:"pointer",flexShrink:0}}>✕</button>
                  </div>
                );
              })}
              {kExps.length===0 && <p style={{color:MUTED,textAlign:"center",marginTop:32}}>記録がないよ</p>}
            </div>
          )}
        </div>
      )}

      {/* ── GOALS ── */}
      {effectiveTab==="money" && monTab==="goals" && (
        <div style={{padding:"12px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>🎯 {young?"もくひょう":"貯金目標"}</p>
            <Btn c={P} label="＋ 追加" onClick={()=>setGAdd(s=>!s)}/>
          </div>
          {myGoals.map(g=>{
            const pct=Math.min(100,Math.round(myBal/g.target*100));
            return (
              <div key={g.id} style={{background:CARD,border:`2px solid ${g.done?G:BORDER}`,borderRadius:18,padding:16,marginBottom:12,position:"relative"}}>
                {g.done && <div style={{position:"absolute",top:-8,right:12,background:G,color:"#fff",fontSize:11,fontWeight:800,padding:"2px 10px",borderRadius:20}}>🎉 達成！</div>}
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                  <span style={{fontSize:28}}>{g.emoji}</span>
                  <div style={{flex:1}}><div style={{fontWeight:800,fontSize:15}}>{g.label}</div><div style={{color:MUTED,fontSize:12}}>目標: {g.target.toLocaleString()}pt</div></div>
                  <button onClick={()=>delGoal(g.id)} style={{background:"none",border:"none",color:MUTED,fontSize:15,cursor:"pointer"}}>✕</button>
                </div>
                <div style={{height:13,background:BORDER,borderRadius:7,overflow:"hidden",marginBottom:5}}><div style={{height:"100%",width:`${pct}%`,background:g.done?G:Y,borderRadius:7,transition:"width .6s"}}/></div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                  <span style={{color:Y,fontWeight:800}}>{pct}% 達成</span>
                  {!g.done && <span style={{color:MUTED}}>あと {Math.max(0,g.target-myBal).toLocaleString()}pt</span>}
                </div>
                {!g.done && myBal>=g.target && <button onClick={()=>markGoal(g.id)} style={{marginTop:10,width:"100%",background:G,border:"none",borderRadius:10,padding:"10px",color:"#fff",fontWeight:900,fontSize:13,cursor:"pointer",fontFamily:F}}>🎉 目標達成！おめでとう！</button>}
              </div>
            );
          })}
          {myGoals.length===0 && !gAdd && <p style={{color:MUTED,textAlign:"center",marginTop:24,fontSize:13}}>目標をつくって貯金しよう！</p>}
          {gAdd && (
            <div style={{background:`${P}15`,border:`2px dashed ${P}`,borderRadius:16,padding:14}}>
              <p style={{fontWeight:800,fontSize:13,color:P,margin:"0 0 10px"}}>新しい目標を追加</p>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <input value={gForm.emoji} onChange={e=>setGForm(f=>({...f,emoji:e.target.value}))} style={{...INP,width:58}}/>
                <input value={gForm.label} onChange={e=>setGForm(f=>({...f,label:e.target.value}))} placeholder="なにを買いたい？" style={INP}/>
              </div>
              <input value={gForm.target} onChange={e=>setGForm(f=>({...f,target:e.target.value}))} type="number" placeholder="目標金額（pt）" style={{...INP,marginBottom:10}}/>
              <div style={{display:"flex",gap:8}}><Btn c={P} label="追加する" onClick={addGoal} disabled={!gForm.label||!gForm.target}/><Btn c={MUTED} label="キャンセル" onClick={()=>setGAdd(false)}/></div>
            </div>
          )}
        </div>
      )}

      {/* ── REWARDS ── */}
      {effectiveTab==="money" && monTab==="rewards" && (
        <div style={{padding:16}}>
          <p style={{color:MUTED,fontSize:12,fontWeight:700,marginBottom:12}}>🎁 ためたポイントでこうかんしよう！</p>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {data.rewards.map(r=>{
              const ok=myBal>=r.cost;
              return (
                <button key={r.id} onClick={()=>setRewardPop(r)}
                  style={{background:ok?CARD:BG,border:`2.5px solid ${ok?P:BORDER}`,borderRadius:18,padding:"13px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:14,textAlign:"left",fontFamily:F,opacity:ok?1:.55}}>
                  {/^r0\d$/.test(r.id)?<img src={`/assets/reward_${r.id}.png`} style={{width:48,height:48,objectFit:"contain",borderRadius:10,flexShrink:0}} alt=""/>:<span style={{fontSize:34}}>{r.emoji}</span>}
                  <div style={{flex:1}}><div style={{fontWeight:800,fontSize:14}}>{r.label}</div><div style={{color:MUTED,fontSize:12,marginTop:2}}>{r.unit}</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontWeight:900,fontSize:16,color:ok?P:MUTED}}>{r.cost.toLocaleString()}pt</div><div style={{fontSize:10,color:ok?G:R,fontWeight:700}}>{ok?"こうかんできる":"残高不足"}</div></div>
                </button>
              );
            })}
          </div>
          <div style={{marginTop:14,background:"#fef9e0",border:`1.5px solid ${Y}`,borderRadius:14,padding:"11px 14px"}}>
            <p style={{margin:0,fontSize:13,fontWeight:700}}>💰 いまの残高: <span style={{fontSize:16,color:G}}>{myBal.toLocaleString()}pt</span></p>
          </div>
        </div>
      )}

      {/* ── LOG ── */}
      {effectiveTab==="more" && (
        <div style={{padding:16}}>
          {/* サブタブ: 履歴 / バッジ / ランキング */}
          <div style={{display:"flex",gap:6,marginBottom:14}}>
            {[["log","📋 履歴"],["badges","🎖 バッジ"],["ranking","🏅 ランキング"]].map(([k,l])=>(
              <button key={k} onClick={()=>setMoreOpen(k==="log"?"log":k==="badges"?"badges":"ranking")}
                style={{flex:1,padding:"7px 0",border:"none",borderRadius:10,
                  background:(moreOpen||"log")===k?GP:"transparent",
                  color:(moreOpen||"log")===k?"#fff":MUTED,
                  fontWeight:(moreOpen||"log")===k?700:400,fontSize:11,cursor:"pointer",fontFamily:F}}>
                {l}
              </button>
            ))}
          </div>
          {(moreOpen||"log")==="log" && (
          <div>
          <div style={{marginBottom:12}}><SortBar options={[["new","新しい順"],["old","古い順"],["pts_high","pt高い順"],["pts_low","pt低い順"]]} value={logSort} onChange={setLogSort}/></div>
          {myLogs.length===0 && <p style={{color:MUTED,textAlign:"center",marginTop:20}}>まだきろくがないよ</p>}
          {[...myLogs].sort((a,b)=>logSort==="new"?b.date.localeCompare(a.date):logSort==="old"?a.date.localeCompare(b.date):logSort==="pts_high"?b.pts-a.pts:a.pts-b.pts).slice(0,50).map(l=>{
            const emoji=l.type==="transfer_out"?"💸":l.type==="transfer_in"?"💌":l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":l.type==="interest"?"💹":l.type==="invest_buy"?"📈":l.type==="invest_sell"?"📉":l.type==="tips"?"💡":([...data.goodTasks,...data.badTasks].find(t=>t.id===l.rid)?.emoji||"📌");
            return(
              <div key={l.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"11px 13px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:20}}>{emoji}</span>
                <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{l.label}</div><div style={{color:MUTED,fontSize:10}}>{fmtDate(l.date)}</div></div>
                <Pt v={l.pts}/>
              </div>
            );
          })}
          </div>
          )}
        </div>
      )}

      {/* ── BADGES ── */}
      {effectiveTab==="more"&&(moreOpen||"log")==="badges"&&<BadgesSection child={child} data={data} update={update}/>}

      {/* ── 記録タブ: ランキング ── */}
      {effectiveTab==="more"&&moreOpen==="ranking"&&(()=>{
        const allMembers=[...data.children,...(data.parents||[])];
        const rank=[...allMembers]
          .filter(m=>m.visibility?.rankingParticipation!==false)
          .map(m=>({member:m,pts:calcMonthlyActivity(m.id,data.logs),streak:(data.streak||{})[m.id]?.cur||0}))
          .sort((a,b)=>b.pts-a.pts)
          .map((r,i)=>({...r,rank:i+1}));
        const MEDAL=["🥇","🥈","🥉"];
        return(
          <div style={{padding:16}}>
            <div style={{background:CARD,borderRadius:16,padding:"16px",border:`1px solid ${BORDER}`,boxShadow:"0 4px 16px rgba(24,35,29,0.06)"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <span style={{fontSize:14}}>🏆</span>
                <span style={{fontSize:12,fontWeight:700,color:TEXT}}>今月の活動ランキング</span>
              </div>
              <div style={{fontSize:10,color:MUTED,marginBottom:12}}>残高・投資損益は含みません。今月の活動ptで比較</div>
              {rank.length===0&&<p style={{color:MUTED,textAlign:"center",padding:"16px 0"}}>参加メンバーがいません</p>}
              {rank.map((r,i)=>(
                <div key={r.member.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<rank.length-1?`1px solid ${BORDER}`:"none"}}>
                  <div style={{width:26,height:26,borderRadius:8,background:i===0?GOLDS:i===1?CARDS:BG,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,flexShrink:0}}>{MEDAL[i]||r.rank}</div>
                  <ChildAvatar child={r.member} size={32}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{r.member.name}</div>
                    <div style={{fontSize:10,color:MUTED}}>🔥 {r.streak}日連続</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontWeight:800,fontSize:14,color:G}}>+{r.pts}pt</div>
                    <div style={{fontSize:10,color:MUTED}}>今月</div>
                  </div>
                </div>
              ))}
            </div>
            {onFamily&&(
              <button onClick={onFamily} style={{width:"100%",marginTop:12,padding:"11px",background:GP,border:"none",borderRadius:12,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                👨👩👧 ファミリー詳細を見る
              </button>
            )}
          </div>
        );
      })()}

      {/* ── TIPS (learn タブに移動済み) ── */}

      {/* ── RANKING ── */}
      {false&&(()=>{
        const month=monthKey();
        const allMembers=[...data.children,...(data.parents||[])];
        const rankings=allMembers.map(m=>{
          const isChild=data.children.some(c=>c.id===m.id);
          const monthLogs=(data.logs||[]).filter(l=>l.cid===m.id&&(l.date||"").startsWith(month));
          const totalLogs=(data.logs||[]).filter(l=>l.cid===m.id);
          const monthPts=monthLogs.reduce((s,l)=>s+l.pts,0);
          const totalPts=bal(data.logs,m.id);
          const taskCount=monthLogs.filter(l=>l.type==="good").length;
          const streak=(data.streak||{})[m.id]?.cur||0;
          return{...m,monthPts,totalPts,taskCount,streak,isChild};
        }).sort((a,b)=>b.monthPts-a.monthPts);

        const medals=["🥇","🥈","🥉"];
        const myRank=rankings.findIndex(r=>r.id===child.id);
        const maxPts=Math.max(...rankings.map(r=>r.monthPts),1);

        return(<div style={{padding:16}}>
          {/* 自分の順位ハイライト */}
          <div style={{background:`linear-gradient(135deg,${Y}30,${G}20)`,border:`2px solid ${Y}`,borderRadius:18,padding:"14px 18px",marginBottom:16,textAlign:"center"}}>
            <div style={{fontSize:40}}>{medals[myRank]||"🏅"}</div>
            <div style={{fontWeight:900,fontSize:22,color:TEXT}}>{myRank+1}位</div>
            <div style={{color:MUTED,fontSize:12}}>今月 {rankings[myRank]?.monthPts?.toLocaleString()}pt獲得</div>
          </div>

          {/* ランキング一覧 */}
          <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 10px"}}>今月のランキング</p>
          {rankings.map((r,i)=>{
            const isMe=r.id===child.id;
            const pct=Math.round(r.monthPts/maxPts*100);
            return(
              <div key={r.id} style={{background:isMe?`${Y}15`:CARD,border:`2px solid ${isMe?Y:BORDER}`,borderRadius:16,padding:"12px 14px",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                  <span style={{fontSize:24,flexShrink:0,minWidth:32,textAlign:"center"}}>{medals[i]||`${i+1}`}</span>
                  <ChildAvatar child={r} size={34}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:800,fontSize:14,color:isMe?TEXT:TEXT}}>{r.name}{isMe&&" 👈"}</div>
                    <div style={{color:MUTED,fontSize:11}}>お手伝い {r.taskCount}回 · 🔥{r.streak}日連続</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontWeight:900,fontSize:16,color:r.monthPts>=0?G:R}}>{r.monthPts>=0?"+":""}{r.monthPts.toLocaleString()}pt</div>
                    <div style={{color:MUTED,fontSize:10}}>合計 {r.totalPts.toLocaleString()}pt</div>
                  </div>
                </div>
                {/* プログレスバー */}
                <div style={{height:6,background:BORDER,borderRadius:3,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${pct}%`,background:isMe?Y:G,borderRadius:3,transition:"width .5s"}}/>
                </div>
              </div>
            );
          })}

          {/* 総合残高ランキング */}
          <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"16px 0 10px"}}>総合残高ランキング</p>
          {[...rankings].sort((a,b)=>b.totalPts-a.totalPts).map((r,i)=>{
            const isMe=r.id===child.id;
            return(
              <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,background:isMe?`${G}10`:BG,border:`1.5px solid ${isMe?G:BORDER}`,borderRadius:14,padding:"10px 13px",marginBottom:6}}>
                <span style={{fontSize:20,minWidth:28,textAlign:"center"}}>{medals[i]||`${i+1}`}</span>
                <ChildAvatar child={r} size={30}/>
                <div style={{flex:1,fontWeight:700,fontSize:13}}>{r.name}{isMe&&" 👈"}</div>
                <div style={{fontWeight:900,fontSize:15,color:r.totalPts>=0?G:R}}>{r.totalPts.toLocaleString()}pt</div>
              </div>
            );
          })}
        </div>);
      })()}

      <style>{`@keyframes popIn{from{transform:translate(-50%,-50%) scale(.5);opacity:0}to{transform:translate(-50%,-50%) scale(1);opacity:1}}`}</style>
      {showSettings&&<SettingsModal data={data} update={update} onClose={()=>setShowSettings(false)} currentMemberId={child.id}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// ── ParentDailyTab ────────────────────────────────────
function ParentDailyTab({data,update,sb}){
  const [selSetId,setSelSetId] = useState(null);
  const [showNewSet,setShowNewSet] = useState(false);
  const [addMode,setAddMode] = useState("pick");
  const [nd,setNd] = useState({emoji:"⭐",label:"",type:"check",pts:"",target:"1"});
  const [editDt,setEditDt] = useState(null);
  const [newSetForm,setNewSetForm] = useState({name:"",emoji:"📋",bonus:"50",startDate:"",endDate:""});

  const sets = (data.dailyTaskSets||[]).map(s=>({
    ...s,
    tasks: Array.isArray(s.tasks)?s.tasks:[],
    bonus: s.bonus??50,
    active: s.active!==false,
    startDate: s.startDate||"",
    endDate: s.endDate||"",
  }));
  const today = todayKey();

  // アクティブセットの自動判定（期間外なら非アクティブ）
  const getSetStatus = s => {
    if(!s.active) return "off";
    if(s.startDate && today < s.startDate) return "pending";
    if(s.endDate   && today > s.endDate)   return "expired";
    return "active";
  };
  const statusLabel = {active:"● 配信中",pending:"⏳ 開始前",expired:"終了",off:"停止中"};
  const statusColor = {active:G,pending:Y,expired:MUTED,off:MUTED};

  const selSet = sets.find(s=>s.id===selSetId)||null;

  const addSet = () => {
    if(!newSetForm.name) return;
    const newId = "set_"+uid();
    const newSet = {
      id:newId, name:newSetForm.name, emoji:newSetForm.emoji,
      tasks:[], bonus:parseInt(newSetForm.bonus)||50,
      startDate:newSetForm.startDate, endDate:newSetForm.endDate,
      active:true,
    };
    update(d=>({...d, dailyTaskSets:[...(d.dailyTaskSets||[]),newSet]}));
    setSelSetId(newId);
    setShowNewSet(false);
    setNewSetForm({name:"",emoji:"📋",bonus:"50",startDate:"",endDate:""});
  };

  const delSet = id => {
    if(sets.length<=1){alert("最低1つはセットが必要です");return;}
    update(d=>({...d,
      dailyTaskSets:(d.dailyTaskSets||[]).filter(s=>s.id!==id),
      activeSetId: d.activeSetId===id ? (d.dailyTaskSets.find(s=>s.id!==id)?.id||"") : d.activeSetId,
    }));
    setSelSetId(null);
  };

  const updateSet = (id,changes) => update(d=>({...d,
    dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===id?{...s,...changes}:s)
  }));

  const activateSet = id => update(d=>({...d, activeSetId:id,
    dailyTaskSets:(d.dailyTaskSets||[]).map(s=>({...s,active:s.id===id?true:s.active}))
  }));

  const addTaskToSet = (setId, task) => update(d=>({...d,
    dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===setId?{...s,tasks:[...s.tasks,task]}:s)
  }));
  const delTaskFromSet = (setId, taskId) => update(d=>({...d,
    dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===setId?{...s,tasks:s.tasks.filter(t=>t.id!==taskId)}:s)
  }));
  const saveTaskEdit = (setId) => {
    if(!editDt) return;
    const pts=parseInt(editDt.pts); if(isNaN(pts)) return;
    update(d=>({...d,
      dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===setId?{...s,tasks:s.tasks.map(t=>t.id===editDt.id?{...editDt,pts,target:parseInt(editDt.target)||1}:t)}:s)
    }));
    setEditDt(null);
  };

  return(<div style={{padding:16}}>

    {/* ── セット一覧 ── */}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
      <p style={{fontWeight:900,fontSize:15,color:TEXT,margin:0}}>📋 タスクセット管理</p>
      <Btn c={G} label="＋ 新セット" onClick={()=>setShowNewSet(true)} sm/>
    </div>

    {/* 新セット作成フォーム */}
    {showNewSet&&<div style={{background:`${G}12`,border:`2px dashed ${G}`,borderRadius:16,padding:16,marginBottom:14}}>
      <p style={{fontWeight:800,fontSize:13,color:G,margin:"0 0 12px"}}>新しいタスクセットを作成</p>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <input value={newSetForm.emoji} onChange={e=>setNewSetForm(f=>({...f,emoji:e.target.value}))} style={{...INP,width:54}} placeholder="絵文字"/>
        <input value={newSetForm.name} onChange={e=>setNewSetForm(f=>({...f,name:e.target.value}))} placeholder="セット名（例：夏休み）" style={INP}/>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
        <span style={{color:MUTED,fontSize:12,fontWeight:700,flexShrink:0}}>全達成ボーナス</span>
        <input value={newSetForm.bonus} onChange={e=>setNewSetForm(f=>({...f,bonus:e.target.value}))} type="number" style={{...INP,flex:1}} placeholder="50"/>
        <span style={{color:MUTED,fontSize:12,flexShrink:0}}>pt</span>
      </div>
      <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 6px"}}>期間（省略可＝常時有効）</p>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
        <input value={newSetForm.startDate} onChange={e=>setNewSetForm(f=>({...f,startDate:e.target.value}))} type="date" style={{...INP,flex:1}}/>
        <span style={{color:MUTED}}>〜</span>
        <input value={newSetForm.endDate} onChange={e=>setNewSetForm(f=>({...f,endDate:e.target.value}))} type="date" style={{...INP,flex:1}}/>
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn c={G} label="作成する" onClick={addSet} disabled={!newSetForm.name} sm/>
        <Btn c={MUTED} label="キャンセル" onClick={()=>setShowNewSet(false)} sm/>
      </div>
    </div>}

    {/* セットカード一覧 */}
    {sets.map(s=>{
      const status=getSetStatus(s);
      const isActive=data.activeSetId===s.id;
      const isOpen=selSetId===s.id;
      return(<div key={s.id} style={{background:CARD,border:`2px solid ${isActive?G:isOpen?B:BORDER}`,borderRadius:18,marginBottom:10,overflow:"hidden"}}>

        {/* セットヘッダー */}
        <div style={{padding:"12px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22,flexShrink:0}}>{s.emoji}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:14,color:TEXT}}>{s.name}</div>
            <div style={{display:"flex",gap:8,marginTop:2,flexWrap:"wrap"}}>
              <span style={{fontSize:10,fontWeight:700,color:statusColor[status]}}>{statusLabel[status]}</span>
              <span style={{fontSize:10,color:MUTED}}>{s.tasks.length}タスク · ボーナス{s.bonus}pt</span>
              {s.startDate&&<span style={{fontSize:10,color:MUTED}}>{s.startDate}〜{s.endDate||"無期限"}</span>}
            </div>
          </div>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            {/* アクティブ切替 */}
            {!isActive&&<button onClick={()=>activateSet(s.id)}
              style={{padding:"4px 10px",background:`${G}15`,border:`1.5px solid ${G}`,borderRadius:8,color:G,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
              選択
            </button>}
            {isActive&&<span style={{padding:"4px 10px",background:`${G}30`,border:`1.5px solid ${G}`,borderRadius:8,color:G,fontWeight:800,fontSize:11}}>使用中</span>}
            {/* 展開 */}
            <button onClick={()=>setSelSetId(isOpen?null:s.id)}
              style={{padding:"4px 8px",background:"transparent",border:`1px solid ${BORDER}`,borderRadius:8,color:MUTED,fontSize:13,cursor:"pointer",fontFamily:F}}>
              {isOpen?"▲":"▼"}
            </button>
            {/* 削除 */}
            {sb(R,"🗑",()=>delSet(s.id))}
          </div>
        </div>

        {/* セット詳細（展開時） */}
        {isOpen&&<div style={{borderTop:`1px solid ${BORDER}`,padding:"12px 14px"}}>

          {/* セット設定編集 */}
          <div style={{background:BG,borderRadius:12,padding:"10px 12px",marginBottom:12}}>
            <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>セット設定</p>
            <div style={{display:"flex",gap:8,marginBottom:6}}>
              <input value={s.emoji} onChange={e=>updateSet(s.id,{emoji:e.target.value})} style={{...INP,width:54}}/>
              <input value={s.name} onChange={e=>updateSet(s.id,{name:e.target.value})} style={INP}/>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:6,alignItems:"center"}}>
              <span style={{color:MUTED,fontSize:11,flexShrink:0}}>ボーナス</span>
              <input value={s.bonus} onChange={e=>updateSet(s.id,{bonus:parseInt(e.target.value)||0})} type="number" style={{...INP,flex:1}}/>
              <span style={{color:MUTED,fontSize:11,flexShrink:0}}>pt</span>
            </div>
            <div style={{display:"flex",gap:6,marginBottom:6,alignItems:"center"}}>
              <span style={{color:MUTED,fontSize:11,flexShrink:0}}>期間</span>
              <input value={s.startDate} onChange={e=>updateSet(s.id,{startDate:e.target.value})} type="date" style={{...INP,flex:1,fontSize:11}}/>
              <span style={{color:MUTED}}>〜</span>
              <input value={s.endDate} onChange={e=>updateSet(s.id,{endDate:e.target.value})} type="date" style={{...INP,flex:1,fontSize:11}}/>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:MUTED,fontSize:11}}>有効</span>
              <button onClick={()=>updateSet(s.id,{active:!s.active})}
                style={{background:s.active?G:BORDER,border:"none",borderRadius:16,width:40,height:22,cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}>
                <div style={{position:"absolute",top:3,left:s.active?20:3,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
              </button>
              <span style={{color:s.active?G:MUTED,fontSize:11,fontWeight:700}}>{s.active?"ON":"OFF"}</span>
            </div>
          </div>

          {/* タスク一覧 */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:0}}>タスク（{s.tasks.length}件）</p>
            <Btn c={G} label="＋ 追加" onClick={()=>{setAddMode("pick");}} sm/>
          </div>
          {s.tasks.map(t=>(
            <div key={t.id} style={{background:BG,borderRadius:12,padding:"9px 12px",marginBottom:6}}>
              {editDt?.id===t.id
                ?<div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}><input value={editDt.emoji} onChange={e=>setEditDt(v=>({...v,emoji:e.target.value}))} style={{...INP,width:50}}/><input value={editDt.label} onChange={e=>setEditDt(v=>({...v,label:e.target.value}))} style={INP}/></div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>
                    {[["check","✅ チェック"],["count","🔢 回数"]].map(([x,l])=><button key={x} onClick={()=>setEditDt(v=>({...v,type:x}))} style={{flex:1,padding:"6px 0",border:`2px solid ${editDt.type===x?G:BORDER}`,borderRadius:8,background:editDt.type===x?`${G}15`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:editDt.type===x?G:MUTED}}>{l}</button>)}
                  </div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>
                    <div style={{flex:1}}><p style={{color:MUTED,fontSize:10,margin:"0 0 2px"}}>pt</p><input value={editDt.pts} onChange={e=>setEditDt(v=>({...v,pts:e.target.value}))} type="number" style={INP}/></div>
                    {editDt.type==="count"&&<div style={{flex:1}}><p style={{color:MUTED,fontSize:10,margin:"0 0 2px"}}>目標回数</p><input value={editDt.target} onChange={e=>setEditDt(v=>({...v,target:e.target.value}))} type="number" style={INP}/></div>}
                  </div>
                  <div style={{display:"flex",gap:6}}><Btn c={G} label="保存" onClick={()=>saveTaskEdit(s.id)} sm/><Btn c={MUTED} label="キャンセル" onClick={()=>setEditDt(null)} sm/></div>
                </div>
                :<div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:18,flexShrink:0}}>{t.emoji}</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13}}>{t.label}</div>
                    <div style={{color:MUTED,fontSize:10}}>{t.type==="check"?"✅":"🔢"} +{t.pts}pt{t.type==="count"&&` · 目標${t.target||1}回`}</div>
                  </div>
                  <div style={{display:"flex",gap:4}}>
                    <Btn c={B} label="✏" onClick={()=>setEditDt({...t,pts:String(t.pts),target:String(t.target||1)})} sm/>
                    <Btn c={R} label="🗑" onClick={()=>delTaskFromSet(s.id,t.id)} sm/>
                  </div>
                </div>}
            </div>
          ))}

          {/* タスク追加パネル */}
          {(()=>{
            const alreadyIds=new Set(s.tasks.map(t=>t.srcId||t.id));
            const available=(data.goodTasks||[]).filter(t=>!alreadyIds.has(t.id));
            return(<div style={{background:`${G}10`,border:`1.5px dashed ${G}`,borderRadius:12,padding:12,marginTop:4}}>
              <div style={{display:"flex",gap:0,background:BORDER,borderRadius:8,overflow:"hidden",marginBottom:10}}>
                {[["pick","📋 お手伝いから選ぶ"],["manual","✏ 手動入力"]].map(([v,l])=>(
                  <button key={v} onClick={()=>setAddMode(v)} style={{flex:1,padding:"7px 0",border:"none",background:addMode===v?G:"transparent",color:addMode===v?"#fff":MUTED,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>
                ))}
              </div>
              {addMode==="pick"?(
                <div style={{maxHeight:220,overflowY:"auto",display:"flex",flexDirection:"column",gap:5}}>
                  {available.length===0&&<p style={{color:MUTED,fontSize:12,textAlign:"center",padding:"8px 0"}}>全て追加済み</p>}
                  {available.map(t=>(
                    <button key={t.id} onClick={()=>addTaskToSet(s.id,{id:uid(),srcId:t.id,emoji:t.emoji,label:t.label,type:"check",pts:t.pts,target:1})}
                      style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:10,padding:"8px 12px",display:"flex",alignItems:"center",gap:8,cursor:"pointer",textAlign:"left",fontFamily:F}}>
                      <span style={{fontSize:18,flexShrink:0}}>{t.emoji}</span>
                      <div style={{flex:1}}><div style={{fontWeight:700,fontSize:12}}>{t.label}</div><div style={{color:MUTED,fontSize:10}}>+{t.pts}pt</div></div>
                      <span style={{color:G,fontSize:16,fontWeight:900}}>+</span>
                    </button>
                  ))}
                </div>
              ):(
                <div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}><input value={nd.emoji} onChange={e=>setNd(v=>({...v,emoji:e.target.value}))} style={{...INP,width:50}}/><input value={nd.label} onChange={e=>setNd(v=>({...v,label:e.target.value}))} placeholder="タスク名" style={INP}/></div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>{[["check","✅"],["count","🔢"]].map(([x,l])=><button key={x} onClick={()=>setNd(v=>({...v,type:x}))} style={{flex:1,padding:"5px 0",border:`2px solid ${nd.type===x?G:BORDER}`,borderRadius:8,background:nd.type===x?`${G}15`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:nd.type===x?G:MUTED}}>{l}</button>)}</div>
                  <div style={{display:"flex",gap:6,marginBottom:8}}>
                    <div style={{flex:1}}><p style={{color:MUTED,fontSize:10,margin:"0 0 2px"}}>pt</p><input value={nd.pts} onChange={e=>setNd(v=>({...v,pts:e.target.value}))} type="number" style={INP}/></div>
                    {nd.type==="count"&&<div style={{flex:1}}><p style={{color:MUTED,fontSize:10,margin:"0 0 2px"}}>目標回数</p><input value={nd.target} onChange={e=>setNd(v=>({...v,target:e.target.value}))} type="number" style={INP}/></div>}
                  </div>
                  <Btn c={G} label="追加する" onClick={()=>{
                    const pts=parseInt(nd.pts);if(!nd.label||isNaN(pts))return;
                    addTaskToSet(s.id,{id:uid(),emoji:nd.emoji,label:nd.label,type:nd.type,pts,target:parseInt(nd.target)||1});
                    setNd({emoji:"⭐",label:"",type:"check",pts:"",target:"1"});
                  }} disabled={!nd.label||!nd.pts} sm/>
                </div>
              )}
            </div>);
          })()}

          {/* 今日の達成状況 */}
          <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${BORDER}`}}>
            <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>今日の達成状況</p>
            {data.children.map(child=>{
              const prog=(data.dailyProgress||{})[child.id]?.[today]||{};
              const done=s.tasks.filter(t=>t.type==="check"?!!prog[t.id]:(prog[t.id]||0)>=(t.target||1)).length;
              const allD=done===s.tasks.length&&s.tasks.length>0;
              return(<div key={child.id} style={{display:"flex",alignItems:"center",gap:8,background:allD?"#e8faf0":BG,border:`1px solid ${allD?G:BORDER}`,borderRadius:10,padding:"7px 10px",marginBottom:6}}>
                <ChildAvatar child={child} size={24}/>
                <span style={{fontWeight:700,fontSize:12,flex:1}}>{child.name}</span>
                <span style={{color:allD?G:MUTED,fontWeight:800,fontSize:11}}>{done}/{s.tasks.length} {allD?"🌟":""}</span>
                <button onClick={()=>{
                  const childBonus=(data.childDailyBonus||{})[child.id]??s.bonus;
                  const amt=parseInt(prompt(`${child.name}にボーナスを付与（デフォルト:${childBonus}pt）`,String(childBonus))||String(childBonus));
                  if(!isNaN(amt)&&amt>0) (()=>{const _e={id:uid(),cid:child.id,type:"grant",label:`🌟 ボーナスpt（${s.name}）`,pts:amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);})();
                }} style={{padding:"3px 8px",background:`${Y}20`,border:`1px solid ${Y}`,borderRadius:7,color:"#9a7000",fontWeight:700,fontSize:10,cursor:"pointer",fontFamily:F}}>
                  🎁 付与
                </button>
              </div>);
            })}
          </div>
        </div>}
      </div>);
    })}

    {sets.length===0&&<div style={{textAlign:"center",padding:"32px 0"}}>
      <p style={{color:MUTED,fontSize:14}}>まだタスクセットがないよ</p>
      <Btn c={G} label="＋ 最初のセットを作る" onClick={()=>setShowNewSet(true)}/>
    </div>}
  </div>);
}


// ── AI Advisor Tab ────────────────────────────────────
function AiAdvisorTab({data}){
  const [loading,setLoading]=useState(false);
  const [result,setResult]=useState(null);
  const [error,setError]=useState(null);

  const buildPrompt=()=>{
    const logs=data.logs||[];
    const children=data.children||[];
    const goodTasks=data.goodTasks||[];
    const badTasks=data.badTasks||[];
    const rewards=data.rewards||[];
    const childStats=children.map(c=>{
      const cLogs=logs.filter(l=>l.cid===c.id);
      const earned=cLogs.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);
      const spent=Math.abs(cLogs.filter(l=>l.pts<0).reduce((s,l)=>s+l.pts,0));
      const taskLogs=cLogs.filter(l=>l.type==="good");
      const rewardLogs=cLogs.filter(l=>l.type==="reward");
      const balance=bal(logs,c.id);
      const taskCounts={};
      taskLogs.forEach(l=>{taskCounts[l.label]=(taskCounts[l.label]||0)+1;});
      const topTasks=Object.entries(taskCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([l,n])=>l+"("+n+"回)");
      const rewCounts={};
      rewardLogs.forEach(l=>{rewCounts[l.label]=(rewCounts[l.label]||0)+1;});
      const topRews=Object.entries(rewCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([l,n])=>l+"("+n+"回)");
      return{name:c.name,age:c.ageMode,balance,earned,spent,ratio:spent>0?(earned/spent).toFixed(1):"0",taskCount:taskLogs.length,topTasks,topRews};
    });
    const taskList=goodTasks.map(t=>t.label+":"+t.pts+"pt").join(", ");
    const badList=badTasks.map(t=>t.label+":"+t.pts+"pt").join(", ");
    const rewardList=rewards.map(r=>r.label+":"+r.cost+"pt").join(", ");
    const statsText=childStats.map(c=>
      "\n- "+c.name+"("+c.age+"): 残高"+c.balance+"pt / 獲得"+c.earned+"pt / 使用"+c.spent+"pt / 稼ぎ消費比"+c.ratio+"倍 / お手伝い"+c.taskCount+"回"+
      " / よくやるタスク:["+(c.topTasks.join(",")||"なし")+"] / よく使うこうかん:["+(c.topRews.join(",")||"なし")+"]"
    ).join("");
    return "あなたは子どもの家庭内ポイント制度のアドバイザーです。以下データを分析して日本語で具体的なアドバイスをください。\n\n"+
      "【お手伝いタスク（プラス）】\n"+taskList+"\n\n"+
      "【マイナスタスク】\n"+badList+"\n\n"+
      "【こうかん一覧】\n"+rewardList+"\n\n"+
      "【子どもの実績】"+statsText+"\n\n"+
      "以下の観点で分析してください（各項目に★1〜5で評価）：\n"+
      "1. ポイントバランスの評価（稼ぎやすさと使いやすさのバランス）\n"+
      "2. タスクptの妥当性（各タスクのpt設定は労力に見合っているか）\n"+
      "3. こうかんptの妥当性（ご褒美のコストは適切か）\n"+
      "4. 子どもごとの行動パターン分析\n"+
      "5. 具体的な改善提案（数値を含む提案3〜5点）\n"+
      "前向きな表現で、家族が実践しやすいアドバイスをお願いします。";
  };

  const runAnalysis=async()=>{
    setLoading(true);setResult(null);setError(null);
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:1000,
          messages:[{role:"user",content:buildPrompt()}]
        })
      });
      const json=await res.json();
      const text=json.content?.find(b=>b.type==="text")?.text||"分析結果を取得できませんでした";
      setResult(text);
    }catch(e){
      setError("分析中にエラーが発生しました。もう一度お試しください。");
    }finally{setLoading(false);}
  };

  const renderResult=text=>text.split("\n").map((line,i)=>{
    const isBold=line.match(/^\d+\./) || line.startsWith("**");
    const isItem=line.startsWith("-")||line.startsWith("・");
    const cleaned=line.replace(/\*\*/g,"").trim();
    if(!cleaned) return <div key={i} style={{height:6}}/>;
    return <p key={i} style={{margin:0,marginBottom:2,fontSize:isBold?13:12,fontWeight:isBold?900:400,color:isBold?TEXT:MUTED,paddingLeft:isItem?12:0,lineHeight:1.7}}>{cleaned}</p>;
  });

  const logs=data.logs||[];
  const totalEarned=logs.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);
  const totalSpent=Math.abs(logs.filter(l=>l.pts<0).reduce((s,l)=>s+l.pts,0));
  const taskCount=logs.filter(l=>l.type==="good").length;
  const rewardCount=logs.filter(l=>l.type==="reward").length;

  return(
    <div style={{padding:16,paddingBottom:40,fontFamily:F}}>
      <div style={{background:"linear-gradient(135deg,#1a1a2e,#16213e)",borderRadius:20,padding:"20px",marginBottom:16,color:"#fff",textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:8}}>🤖</div>
        <h2 style={{fontWeight:900,fontSize:18,margin:"0 0 6px",color:"#fff"}}>AI ポイント分析</h2>
        <p style={{color:"#aaa",fontSize:12,margin:"0 0 16px",lineHeight:1.6}}>タスクpt・こうかんコスト・行動パターンを総合分析します</p>
        <button onClick={runAnalysis} disabled={loading}
          style={{background:loading?"#333":"linear-gradient(135deg,#f5c842,#34c77b)",border:"none",borderRadius:14,padding:"13px 32px",color:loading?"#888":"#1a1a2e",fontWeight:900,fontSize:15,cursor:loading?"default":"pointer",fontFamily:F,opacity:loading?0.7:1,width:"100%"}}>
          {loading?"🔄 分析中（10〜20秒）...":"✨ AI分析をスタート"}
        </button>
      </div>

      {!result&&!loading&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
          {[["📈","獲得合計",totalEarned.toLocaleString()+"pt",G],["📉","使用合計",totalSpent.toLocaleString()+"pt",R],["🏆","お手伝い",taskCount+"回",B],["🎁","こうかん",rewardCount+"回",P]].map(([e,l,v,c])=>(
            <div key={l} style={{background:CARD,border:"1.5px solid "+BORDER,borderRadius:14,padding:"12px 14px",textAlign:"center"}}>
              <div style={{fontSize:22,marginBottom:4}}>{e}</div>
              <div style={{color:MUTED,fontSize:11,fontWeight:700,marginBottom:2}}>{l}</div>
              <div style={{fontWeight:900,fontSize:16,color:c}}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {error&&<div style={{background:"#fef0ef",border:"1.5px solid "+R,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
        <p style={{color:R,fontWeight:700,fontSize:13,margin:0}}>{error}</p>
      </div>}

      {result&&(
        <div style={{background:CARD,border:"2px solid "+G,borderRadius:20,padding:"18px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,paddingBottom:12,borderBottom:"1px solid "+BORDER}}>
            <span style={{fontSize:20}}>🤖</span>
            <div>
              <div style={{fontWeight:900,fontSize:14,color:TEXT}}>AI分析レポート</div>
              <div style={{color:MUTED,fontSize:10}}>{new Date().toLocaleDateString("ja-JP")} 生成</div>
            </div>
          </div>
          <div>{renderResult(result)}</div>
          <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid "+BORDER,display:"flex",gap:8}}>
            <button onClick={runAnalysis} style={{flex:1,padding:"10px 0",background:G+"15",border:"1.5px solid "+G,borderRadius:12,color:G,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>🔄 再分析</button>
            <button onClick={()=>navigator.clipboard?.writeText(result)} style={{flex:1,padding:"10px 0",background:B+"15",border:"1.5px solid "+B,borderRadius:12,color:B,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>📋 コピー</button>
          </div>
        </div>
      )}
    </div>
  );
}


// ── 運用損益コンポーネント（株・為替） ────────────────────────
function InvestLearnTab({child, data, update, onRanking}){
  const [sub,setSub]=useState("stocks");
  const perm=(child.permissions||{});
  const canTrade=perm[sub]==="trade";
  const op=calcMemberOperation(child.id,data,sub);
  const stocks=data.stocks||[];
  const forex=data.forex||{};

  return(
    <div style={{padding:"16px 20px"}}>
      <div style={{background:"#E5F0FF",borderRadius:12,padding:"10px 14px",marginBottom:14,fontSize:11,color:"#3478D4",fontWeight:600}}>
        📊 これは実際のお金を使わない投資シミュレーションです。価格は上下し、増えることも減ることもあります。
      </div>
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {[["stocks","株式"],["forex","為替"]].map(([k,l])=>(
          <button key={k} onClick={()=>setSub(k)} style={{flex:1,padding:"8px 0",border:"none",borderRadius:10,background:sub===k?GP:"transparent",color:sub===k?"#fff":MUTED,fontWeight:sub===k?700:400,fontSize:12,cursor:"pointer",fontFamily:F}}>{l}</button>
        ))}
      </div>
      {op&&(
        <div style={{background:CARD,borderRadius:16,padding:"14px",marginBottom:12,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          <div style={{fontSize:11,color:MUTED,marginBottom:8}}>運用成績（手数料込み）</div>
          <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:4}}>
            <span style={{fontSize:28,fontWeight:900,color:op.rate>=0?G:R,lineHeight:1}}>{op.rate>=0?"+":""}{op.rate.toFixed(1)}%</span>
            <span style={{fontSize:14,fontWeight:700,color:op.pt>=0?G:R}}>{op.pt>=0?"+":""}{op.pt}pt</span>
          </div>
          <div style={{fontSize:11,color:MUTED}}>投資額：{op.cost}pt → 現在評価：{op.net}pt</div>
          <div style={{fontSize:10,color:MUTED,marginTop:3}}>手数料：{sub==="stocks"?"売買10%":"売買2%"}</div>
          {onRanking&&(
            <button onClick={onRanking} style={{marginTop:10,width:"100%",padding:"8px",background:GS,border:`1px solid ${G}30`,borderRadius:10,color:GP,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
              🏆 運用ランキングを見る
            </button>
          )}
        </div>
      )}
      {/* 株式一覧 */}
      {sub==="stocks"&&stocks.map((s,i)=>(
        <div key={i} style={{background:CARD,borderRadius:14,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          <div style={{width:36,height:36,borderRadius:10,background:GS,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{s.emoji}</div>
          <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13,color:TEXT}}>{s.name}</div><div style={{fontSize:10,color:MUTED}}>{s.ticker}</div></div>
          <div style={{textAlign:"right"}}>
            <div style={{fontWeight:700,fontSize:14,color:TEXT}}>{s.price?.toLocaleString()}{s.currency==="JPY"?"円":"$"}</div>
            <div style={{fontSize:11,fontWeight:600,color:(s.lastChange||0)>=0?G:R}}>{(s.lastChange||0)>=0?"+":""}{(s.lastChange||0).toFixed(1)}%</div>
          </div>
        </div>
      ))}
      {/* 為替一覧 */}
      {sub==="forex"&&Object.values(forex).map((fx,i)=>(
        <div key={i} style={{background:CARD,borderRadius:14,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          <div style={{width:36,height:36,borderRadius:10,background:"#E5F0FF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{fx.flag}</div>
          <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13,color:TEXT}}>{fx.name||fx.code}</div><div style={{fontSize:10,color:MUTED}}>1 {fx.code} = ¥{(fx.price||0).toFixed(fx.code==="KRW"?3:2)}</div></div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,fontWeight:600,color:(fx.changePct||0)>=0?G:R}}>{(fx.changePct||0)>=0?"+":""}{(fx.changePct||0).toFixed(2)}%</div>
            {fx.realData&&<div style={{fontSize:9,color:G,fontWeight:600}}>LIVE</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── ファミリー公開画面（子ども・親共通） ───────────────────────
function FamilyPublicScreen({data, viewerRole, onBack}){
  const [metric,setMetric]=useState("approved_activity_points");
  const [opTab,setOpTab]=useState("total");
  const fs=data.familySettings||INIT.familySettings;
  const allMembers=[...data.children,...(data.parents||[])];

  // 活動ランキング（投資除外・承認済み活動のみ）
  const actRank=[...allMembers]
    .filter(m=>m.visibility?.rankingParticipation!==false)
    .map(m=>({member:m,pts:calcMonthlyActivity(m.id,data.logs),streak:(data.streak||{})[m.id]?.cur||0}))
    .sort((a,b)=>b.pts-a.pts)
    .map((r,i)=>({...r,rank:i+1}));

  // 運用ランキング（手数料込み損益率）
  const opRank=[...allMembers]
    .filter(m=>m.visibility?.operationRankingParticipation!==false&&(m.permissions||{}).investment==="trade")
    .map(m=>{
      const op=calcMemberOperation(m.id,data,opTab);
      if(!op) return null;
      return{member:m,op};
    })
    .filter(Boolean)
    .sort((a,b)=>b.op.rate-a.op.rate)
    .map((r,i)=>({...r,rank:i+1}));

  const METRICS=[
    ["approved_activity_points","活動"],
    ["streak","継続"],
    ["goals_completed","目標"],
    ["operation_return_rate","運用"],
  ];
  const MEDAL=["🥇","🥈","🥉"];

  return(
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:40}}>
      <div style={{padding:"52px 20px 16px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",boxShadow:"0 2px 8px rgba(24,35,29,0.05)",fontSize:18,color:TEXTS}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:15,color:GP}}>ファミリー</div>
        </div>
        {/* ランキング切替 */}
        <div style={{background:CARD,borderRadius:14,padding:"6px",display:"flex",gap:2,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          {METRICS.map(([k,l])=>(
            <button key={k} onClick={()=>setMetric(k)} style={{flex:1,padding:"7px 4px",border:"none",borderRadius:10,background:metric===k?GP:"transparent",color:metric===k?"#fff":MUTED,fontWeight:metric===k?700:400,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"0 20px",display:"flex",flexDirection:"column",gap:12}}>
        {/* 家族ミッション */}
        {fs.familyMission?.enabled&&(()=>{
          const missionPts=(data.logs||[]).filter(l=>["daily","good","bad"].includes(l.type)&&l.pts>0).reduce((s,l)=>s+l.pts,0);
          const target=fs.familyMission?.target||3000;
          const pct=Math.min(100,Math.floor(missionPts/target*100));
          return(
            <div style={{background:`linear-gradient(135deg,${GP}E8,#0d5c38)`,borderRadius:20,padding:"18px",color:"#fff"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12}}>
                <span style={{fontSize:13}}>❤</span>
                <span style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.75)"}}>今月の家族ミッション</span>
              </div>
              <div style={{fontSize:14,fontWeight:700,marginBottom:8}}>{fs.familyMission?.label||"みんなの活動で育てよう"}</div>
              <div style={{background:"rgba(255,255,255,0.15)",borderRadius:999,height:8,overflow:"hidden",marginBottom:6}}>
                <div style={{width:`${pct}%`,height:"100%",background:"#86efac",borderRadius:999}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.55)"}}>{missionPts.toLocaleString()} / {target.toLocaleString()}pt</span>
                <span style={{fontSize:13,fontWeight:800,color:"#86efac"}}>{pct}%</span>
              </div>
              <div style={{marginTop:8,fontSize:10,color:"rgba(255,255,255,0.45)"}}>🎁 {fs.familyMission?.reward||"達成報酬"} · 活動・お手伝いのみ対象</div>
            </div>
          );
        })()}

        {/* 活動ランキング */}
        {metric!=="operation_return_rate"&&(
          <div style={{background:CARD,borderRadius:18,padding:"16px",boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:14}}>🏆</span>
                <span style={{fontSize:11,fontWeight:700,color:TEXT}}>{METRICS.find(m=>m[0]===metric)?.[1]}ランキング</span>
              </div>
              <span style={{fontSize:10,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:600}}>
                {metric==="approved_activity_points"?"今月の活動pt":metric==="streak"?"継続日数":"目標達成"}
              </span>
            </div>
            <div style={{fontSize:10,color:MUTED,marginBottom:12}}>残高・投資損益は含みません</div>
            {actRank.map((r,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<actRank.length-1?`1px solid ${BORDER}`:"none"}}>
                <div style={{width:26,height:26,borderRadius:8,background:i===0?GOLDS:i===1?CARDS:BG,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,flexShrink:0}}>{MEDAL[i]||i+1}</div>
                <ChildAvatar child={r.member} size={32}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{r.member.name}</div>
                  <div style={{fontSize:10,color:MUTED}}>🔥 {r.streak}日連続</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:800,fontSize:14,color:G}}>+{r.pts}pt</div>
                  <div style={{fontSize:10,color:MUTED}}>今月</div>
                </div>
              </div>
            ))}
            <div style={{marginTop:10,padding:"7px 12px",background:BG,borderRadius:10,display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:10}}>🔒</span>
              <span style={{fontSize:10,color:MUTED}}>残高・目標は本人と管理者のみ閲覧</span>
            </div>
          </div>
        )}

        {/* 運用ランキング（親子全員参加） */}
        {metric==="operation_return_rate"&&(
          <div style={{background:CARD,borderRadius:18,padding:"16px",boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
              <span style={{fontSize:14}}>📊</span>
              <span style={{fontSize:11,fontWeight:700,color:TEXT}}>運用ランキング</span>
            </div>
            <div style={{background:"#E5F0FF",borderRadius:9,padding:"7px 10px",marginBottom:12,fontSize:10,color:"#3478D4"}}>
              これは実際のお金を使わないシミュレーションです。手数料を含めた損益率で比較しています。
            </div>
            {/* サブタブ */}
            <div style={{display:"flex",gap:6,marginBottom:12}}>
              {[["total","総合"],["stocks","株式"],["forex","為替"]].map(([k,l])=>(
                <button key={k} onClick={()=>setOpTab(k)} style={{flex:1,padding:"6px 0",border:"none",borderRadius:8,background:opTab===k?"#3478D4":"transparent",color:opTab===k?"#fff":MUTED,fontWeight:opTab===k?700:400,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>
              ))}
            </div>
            {opRank.length===0&&(
              <div style={{textAlign:"center",padding:"20px 0",color:MUTED,fontSize:13}}>まだ運用を始めているメンバーがいません</div>
            )}
            {opRank.map((r,i)=>{
              const isPos=r.op.rate>=0;
              const showDetail=r.member.visibility?.investmentResultToFamily==="full";
              return(
                <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<opRank.length-1?`1px solid ${BORDER}`:"none"}}>
                  <div style={{width:26,height:26,borderRadius:8,background:i===0?GOLDS:i===1?CARDS:BG,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,flexShrink:0}}>{MEDAL[i]||i+1}</div>
                  <ChildAvatar child={r.member} size={32}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{r.member.name}</div>
                    {showDetail
                      ?<div style={{fontSize:10,color:MUTED}}>元本{r.op.cost}pt</div>
                      :<div style={{fontSize:10,color:MUTED,display:"flex",alignItems:"center",gap:3}}>🔒 損益のみ公開</div>
                    }
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontWeight:900,fontSize:16,color:isPos?G:R}}>{isPos?"+":""}{r.op.rate.toFixed(1)}%</div>
                    <div style={{fontSize:11,fontWeight:600,color:isPos?G:R}}>{isPos?"+":""}{r.op.pt}pt</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 親専用ファミリー管理画面 ─────────────────────────────────
function FamilyGuardianScreen({data, onBack, onPublicView}){
  const children=data.children||[];
  return(
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:40}}>
      <div style={{padding:"52px 20px 16px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",boxShadow:"0 2px 8px rgba(24,35,29,0.05)",fontSize:18,color:TEXTS}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:15,color:GP}}>ファミリー管理</div>
        </div>
        <button onClick={onPublicView} style={{background:GS,borderRadius:12,padding:"10px 14px",border:`1px solid ${G}30`,display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontFamily:F,width:"100%",textAlign:"left",marginBottom:16}}>
          <span style={{fontSize:14}}>👁</span>
          <div style={{flex:1,fontSize:12,fontWeight:700,color:GP}}>公開表示プレビューを見る</div>
          <ChevronRightIcon/>
        </button>
      </div>
      <div style={{padding:"0 20px",display:"flex",flexDirection:"column",gap:12}}>
        <div style={{fontSize:11,fontWeight:700,color:MUTED,letterSpacing:.5}}>子どもの詳細状況</div>
        {children.map((m,idx)=>{
          const b=bal(data.logs,m.id);
          const monthAct=calcMonthlyActivity(m.id,data.logs);
          const topG=(data.goals||[]).filter(g=>g.cid===m.id&&!g.done)[0];
          const pct=topG?Math.min(100,Math.floor(b/topG.target*100)):0;
          const op=calcMemberOperation(m.id,data,"total");
          return(
            <div key={m.id} style={{background:CARD,borderRadius:18,padding:"16px",boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                <ChildAvatar child={m} size={40}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,color:TEXT}}>{m.name}</div>
                  <div style={{fontSize:11,color:MUTED}}>{m.gradeLabel||""} · {m.displayMode}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:800,fontSize:18,color:TEXT}}>{b.toLocaleString()}pt</div>
                  <div style={{fontSize:11,color:G,fontWeight:600}}>+{monthAct}pt 今月</div>
                </div>
              </div>
              {topG&&(
                <div style={{background:BG,borderRadius:10,padding:"8px 12px",marginBottom:op?8:0}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontSize:11,color:TEXTS}}>{topG.label}</span>
                    <span style={{fontSize:11,fontWeight:700,color:GP}}>{pct}%</span>
                  </div>
                  <div style={{background:BORDER,borderRadius:999,height:5,overflow:"hidden"}}>
                    <div style={{width:`${pct}%`,height:"100%",background:G,borderRadius:999}}/>
                  </div>
                </div>
              )}
              {op&&(
                <div style={{background:BG,borderRadius:10,padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:11,color:TEXTS}}>運用成績（総合）</span>
                  <span style={{fontSize:12,fontWeight:700,color:op.rate>=0?G:R}}>{op.rate>=0?"+":""}{op.rate.toFixed(1)}%（{op.pt>=0?"+":""}{op.pt}pt）</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ParentScreen({ data, update, onBack }) {
  const [tab, setTab] = useState("overview");

  // grant
  const [grantChild, setGrantChild] = useState(null);
  const [grantAmt,   setGrantAmt]   = useState("");
  const [grantLabel, setGrantLabel] = useState("おこづかい");

  // child mgmt
  const [editChild,     setEditChild]     = useState(null);
  const [showAddChild,  setShowAddChild]  = useState(false);
  const [delChild,      setDelChild]      = useState(null);
  const [ncName, setNcName] = useState(""); const [ncEmoji, setNcEmoji] = useState("😊");
  const [ncPin,  setNcPin]  = useState(""); const [ncMode,  setNcMode]  = useState("middle");

  // tasks
  const [editTask,  setEditTask]  = useState(null);
  const [newTask,   setNewTask]   = useState(null);
  const [overModal, setOverModal] = useState(null);
  const [ntLabel, setNtLabel]=useState(""); const [ntEmoji, setNtEmoji]=useState("⭐"); const [ntPts, setNtPts]=useState("");

  // rewards
  const [editReward,    setEditReward]    = useState(null);
  const [showAddReward, setShowAddReward] = useState(false);
  const [nrLabel,setNrLabel]=useState(""); const [nrEmoji,setNrEmoji]=useState("🎁"); const [nrCost,setNrCost]=useState(""); const [nrUnit,setNrUnit]=useState("");

  // gacha
  const [gachaEdit, setGachaEdit] = useState(null);

  // kakeibo child picker
  const [kChild, setKChild] = useState(null);

  // categories
  const [editCat,    setEditCat]    = useState(null);
  const [showAddCat, setShowAddCat] = useState(false);
  const [ncatEmoji, setNcatEmoji]=useState("🏷"); const [ncatLabel, setNcatLabel]=useState(""); const [ncatColor, setNcatColor]=useState("#6b7280");

  const sb = (c,l,fn,dis) => <Btn c={c} label={l} onClick={fn} disabled={dis} sm/>;

  const doGrant = () => {
    const amt=parseInt(grantAmt); if(!amt||!grantChild)return;
    (()=>{const _e={id:uid(),cid:grantChild.id,type:"grant",label:grantLabel||"おこづかい",pts:amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);})();
    setGrantChild(null); setGrantAmt(""); setGrantLabel("おこづかい");
  };

  const addChild = () => {
    if(!ncName||ncPin.length!==4)return;
    update(d=>({...d,children:[...d.children,{id:uid(),name:ncName,emoji:ncEmoji,pin:ncPin,ageMode:ncMode}]}));
    setShowAddChild(false); setNcName(""); setNcEmoji("😊"); setNcPin(""); setNcMode("middle");
  };
  const saveChild = () => {
    if(!editChild||editChild.pin.length!==4)return;
    update(d=>({...d,children:d.children.map(c=>c.id===editChild.id?editChild:c)}));
    setEditChild(null);
  };
  const confirmDelChild = id => {
    update(d=>({...d,children:d.children.filter(c=>c.id!==id),logs:d.logs.filter(l=>l.cid!==id),expenses:(d.expenses||[]).filter(e=>e.cid!==id),goals:(d.goals||[]).filter(g=>g.cid!==id)}));
    setDelChild(null);
  };

  const saveTask = () => {
    if(!editTask)return; const pts=parseInt(editTask.pts); if(isNaN(pts))return;
    const k=editTask.kind==="good"?"goodTasks":"badTasks";
    update(d=>({...d,[k]:d[k].map(t=>t.id===editTask.id?{...t,label:editTask.label,emoji:editTask.emoji,pts}:t)}));
    setEditTask(null);
  };
  const delTask = (kind,id) => { const k=kind==="good"?"goodTasks":"badTasks"; update(d=>({...d,[k]:d[k].filter(t=>t.id!==id)})); };
  const addTask = () => {
    if(!ntLabel||!ntPts)return; const pts=parseInt(ntPts); if(isNaN(pts))return;
    const kind=newTask.kind; const k=kind==="good"?"goodTasks":"badTasks";
    const fp=kind==="bad"&&pts>0?-pts:pts;
    update(d=>({...d,[k]:[...d[k],{id:uid(),emoji:ntEmoji,label:ntLabel,pts:fp,over:{}}]}));
    setNewTask(null); setNtLabel(""); setNtEmoji("⭐"); setNtPts("");
  };
  const setOver = (taskId, kind, cid, val) => {
    const k=kind==="good"?"goodTasks":"badTasks";
    const v=val===""?undefined:parseInt(val);
    update(d=>({...d,[k]:d[k].map(t=>t.id===taskId?{...t,over:{...t.over,[cid]:v}}:t)}));
    setOverModal(m=>m?{...m,task:{...m.task,over:{...m.task.over,[cid]:v}}}:m);
  };

  const saveReward = () => {
    if(!editReward)return; const cost=parseInt(editReward.cost); if(isNaN(cost)||cost<=0)return;
    update(d=>({...d,rewards:d.rewards.map(r=>r.id===editReward.id?{...editReward,cost}:r)}));
    setEditReward(null);
  };
  const delReward = id => update(d=>({...d,rewards:d.rewards.filter(r=>r.id!==id)}));
  const addReward = () => {
    const cost=parseInt(nrCost); if(!nrLabel||isNaN(cost)||cost<=0)return;
    update(d=>({...d,rewards:[...d.rewards,{id:uid(),emoji:nrEmoji,label:nrLabel,cost,unit:nrUnit||"特典"}]}));
    setShowAddReward(false); setNrLabel(""); setNrEmoji("🎁"); setNrCost(""); setNrUnit("");
  };

  const saveGacha = () => {
    const total=gachaEdit.reduce((s,g)=>s+Number(g.rate),0);
    if(total!==100){alert(`出現率の合計が${total}%です。合計100%にしてください。`);return;}
    update(d=>({...d,gacha:gachaEdit.map(g=>({...g,rate:Number(g.rate),min:Number(g.min),max:Number(g.max)}))}));
    setGachaEdit(null);
  };

  const saveCat=()=>{if(!editCat)return;update(d=>({...d,cats:(d.cats||[]).map(c=>c.id===editCat.id?editCat:c)}));setEditCat(null);};
  const delCat=id=>update(d=>({...d,cats:(d.cats||[]).filter(c=>c.id!==id)}));
  const addCat=()=>{if(!ncatLabel)return;update(d=>({...d,cats:[...(d.cats||[]),{id:uid(),emoji:ncatEmoji,label:ncatLabel,color:ncatColor}]}));setShowAddCat(false);setNcatLabel("");setNcatEmoji("🏷");setNcatColor("#6b7280");};

  const TABS=[["overview","ホーム"],["family","ファミリー"],["children","承認・管理"],["tasks","タスク"],["daily","毎日"],["rewards","特典"],["learn","学ぶ"],["log","履歴"]];
  const AGE_MODES={young:{emoji:"🐣",label:"幼児・低学年"},middle:{emoji:"⭐",label:"小学生"},senior:{emoji:"🔥",label:"中高生"}};

  // kakeibo child view
  if (kChild) {
    const child = data.children.find(c=>c.id===kChild);
    if (!child) { setKChild(null); return null; }
    return (
      <div style={{minHeight:"100vh",background:BG,fontFamily:F}}>
        <div style={{background:TEXT,padding:"14px 18px",display:"flex",alignItems:"center",gap:12}}>
          <button onClick={()=>setKChild(null)} style={{background:"none",border:"none",color:MUTED,fontSize:26,cursor:"pointer"}}>‹</button>
          <span style={{fontSize:22}}>{child.emoji}</span>
          <span style={{color:Y,fontSize:17,fontWeight:900}}>{child.name}の家計簿</span>
        </div>
        <ChildScreen child={child} data={data} update={update} onBack={()=>setKChild(null)}/>
      </div>
    );
  }

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:80}}>
      {/* 新ヘッダー */}
      <div style={{background:BG,padding:"52px 20px 0"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,color:TEXTS,boxShadow:"0 2px 8px rgba(24,35,29,0.05)"}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:14,color:GP,letterSpacing:.5}}>Tane Money</div>
          <button onClick={()=>setTab("children")} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,boxShadow:"0 2px 8px rgba(24,35,29,0.05)"}}>⚙</button>
        </div>
        {/* 親自身の残高カード */}
        {(()=>{
          const parentMember=(data.parents||[])[0];
          if(!parentMember) return null;
          const pBal=bal(data.logs,parentMember.id);
          const thisMonth=new Date().toISOString().slice(0,7);
          const pDelta=(data.logs||[]).filter(l=>l.cid===parentMember.id&&(l.date||"").startsWith(thisMonth)).reduce((s,l)=>s+l.pts,0);
          const pStreak=(data.streak||{})[parentMember.id]?.cur||0;
          const topGoal=(data.goals||[]).filter(g=>g.cid===parentMember.id&&!g.done)[0];
          const pct=topGoal?Math.min(100,Math.floor(pBal/topGoal.target*100)):0;
          return(
            <div style={{background:GP,borderRadius:22,padding:"20px",marginBottom:20,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-24,right:-24,width:120,height:120,borderRadius:"50%",background:"rgba(255,255,255,0.06)"}}/>
              <div style={{position:"relative",zIndex:1}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                  <ChildAvatar child={parentMember} size={32}/>
                  <div>
                    <div style={{color:"rgba(255,255,255,0.75)",fontSize:11,fontWeight:600}}>こんにちは、{parentMember.name}</div>
                    <div style={{color:"rgba(255,255,255,0.45)",fontSize:10}}>現在のタネ</div>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"flex-end",gap:6,marginBottom:10}}>
                  <div style={{color:"#fff",fontSize:40,fontWeight:900,lineHeight:1,letterSpacing:-1}}>{pBal.toLocaleString()}</div>
                  <div style={{color:"rgba(255,255,255,0.65)",fontSize:14,fontWeight:600,marginBottom:5}}>pt</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:12,fontWeight:700,color:pDelta>=0?"#86efac":"#fca5a5"}}>{pDelta>=0?"+":""}{pDelta.toLocaleString()}pt</span>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.45)"}}>今月</span>
                  {pStreak>=3&&<div style={{display:"flex",alignItems:"center",gap:3,background:"rgba(255,255,255,0.12)",padding:"3px 8px",borderRadius:999}}>
                    <span style={{fontSize:10,color:"#fff",fontWeight:600}}>🔥 {pStreak}日連続</span>
                  </div>}
                </div>
                {topGoal&&(
                  <div style={{marginTop:12,background:"rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 12px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span style={{fontSize:11,color:"rgba(255,255,255,0.7)"}}>{topGoal.label}</span>
                      <span style={{fontSize:11,fontWeight:700,color:"#86efac"}}>{pct}%</span>
                    </div>
                    <div style={{background:"rgba(255,255,255,0.2)",borderRadius:999,height:5,overflow:"hidden"}}>
                      <div style={{width:`${pct}%`,height:"100%",background:"#86efac",borderRadius:999}}/>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
      {/* タブナビゲーション */}
      <div style={{display:"flex",background:CARD,borderBottom:`1px solid ${BORDER}`,overflowX:"auto",scrollbarWidth:"none",position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 8px rgba(24,35,29,0.04)"}}>
        {TABS.map(([v,l])=>(
          <button key={v} onClick={()=>setTab(v)}
            style={{flex:"0 0 auto",padding:"12px 14px 10px",border:"none",borderBottom:tab===v?`2.5px solid ${GP}`:"2.5px solid transparent",background:"none",color:tab===v?GP:MUTED,fontWeight:tab===v?700:500,fontSize:11,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap",transition:"all .15s"}}>
            {l}
          </button>
        ))}
            </div>

      {/* OVERVIEW */}
      {tab==="overview" && (
        <div style={{padding:16}}>
          {data.children.map(child=>(
            <div key={child.id} style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:20,padding:16,marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                <span style={{fontSize:34}}>{child.emoji}</span>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:15}}>{child.name} <span style={{background:`${P}20`,color:P,fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:8}}>{AGE_MODES[child.ageMode||"middle"].label}</span></div>
                  <div style={{fontWeight:900,fontSize:24,color:G}}>{bal(data.logs,child.id).toLocaleString()}pt</div>
                </div>
              </div>
              {grantChild?.id===child.id ? (
                <div style={{background:"#fef9e0",borderRadius:14,padding:14}}>
                  <p style={{margin:"0 0 8px",fontWeight:700,fontSize:13}}>おこづかいを付与する</p>
                  <input value={grantLabel} onChange={e=>setGrantLabel(e.target.value)} placeholder="ラベル" style={{...INP,marginBottom:8}}/>
                  <input value={grantAmt} onChange={e=>setGrantAmt(e.target.value)} type="number" placeholder="金額（pt）" style={{...INP,marginBottom:10}}/>
                  <div style={{display:"flex",gap:8}}>{sb(G,"✅ 付与する",doGrant)}{sb(MUTED,"キャンセル",()=>setGrantChild(null))}</div>
                </div>
              ) : (
                <button onClick={()=>setGrantChild(child)} style={{width:"100%",background:Y,border:"none",borderRadius:12,padding:11,fontWeight:800,fontSize:13,color:TEXT,cursor:"pointer",fontFamily:F}}>🎁 おこづかいを付与する</button>
              )}
            </div>
          ))}
          {/* monthly summary */}
          <div style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:16,marginTop:4}}>
            <p style={{fontWeight:800,fontSize:13,color:MUTED,margin:"0 0 12px"}}>📋 今月のまとめ</p>
            {data.children.map(child=>{
              const ym=monthKey();
              const logs=(data.logs||[]).filter(l=>l.cid===child.id&&(l.date||"").startsWith(ym));
              const earned=logs.filter(l=>l.type==="good").reduce((s,l)=>s+l.pts,0);
              const spent=(data.expenses||[]).filter(e=>e.cid===child.id&&(e.date||"").startsWith(ym)).reduce((s,e)=>s+e.amt,0);
              const streak=data.streak?.[child.id]?.cur||0;
              return (
                <div key={child.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:`1px solid ${BORDER}`}}>
                  <span style={{fontSize:24}}>{child.emoji}</span>
                  <span style={{fontWeight:700,fontSize:14,flex:1}}>{child.name}</span>
                  <div style={{textAlign:"right",fontSize:12}}>
                    <div style={{color:G,fontWeight:700}}>お手伝い +{earned}pt</div>
                    <div style={{color:R,fontWeight:700}}>支出 -{spent}pt</div>
                    <div style={{color:MUTED}}>🔥{streak}日連続</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* CHILDREN */}
      {tab==="children" && (
        <div style={{padding:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>こどもの管理</p>
            <Btn c={G} label="＋ 追加" onClick={()=>setShowAddChild(true)}/>
          </div>
          {data.children.map(child=>(
            <div key={child.id} style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:14,marginBottom:12}}>
              {delChild===child.id ? (
                <div style={{textAlign:"center"}}>
                  <p style={{fontWeight:800,color:R,marginBottom:8}}>⚠ {child.name}のデータを全て削除しますか？</p>
                  <p style={{color:MUTED,fontSize:12,marginBottom:12}}>履歴・家計簿・目標も全部消えます。</p>
                  <div style={{display:"flex",gap:8,justifyContent:"center"}}>{sb(R,"削除する",()=>confirmDelChild(child.id))}{sb(MUTED,"キャンセル",()=>setDelChild(null))}</div>
                </div>
              ) : editChild?.id===child.id ? (
                <div>
                  {/* アバター編集 */}
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
                    <div style={{position:"relative",flexShrink:0}}>
                      <ChildAvatar child={editChild} size={60}/>
                      <label style={{position:"absolute",bottom:-4,right:-4,width:24,height:24,borderRadius:"50%",background:B,border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:13,color:"#fff"}}>
                        +
                        <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
                          const file=e.target.files&&e.target.files[0]; if(!file) return;
                          const reader=new FileReader();
                          reader.onload=ev=>{
                            const img=new Image();
                            img.onload=()=>{
                              const canvas=document.createElement("canvas");
                              canvas.width=200; canvas.height=200;
                              const ctx=canvas.getContext("2d");
                              const s=Math.min(img.width,img.height);
                              const sx=(img.width-s)/2, sy=(img.height-s)/2;
                              ctx.drawImage(img,sx,sy,s,s,0,0,200,200);
                              setEditChild(c=>({...c,avatar:canvas.toDataURL("image/jpeg",0.8)}));
                            };
                            img.src=ev.target.result;
                          };
                          reader.readAsDataURL(file);
                        }}/>
                      </label>
                    </div>
                    <div style={{flex:1}}>
                      <p style={{color:MUTED,fontSize:11,margin:"0 0 4px"}}>絵文字（写真がない場合）</p>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <input value={editChild.emoji} onChange={e=>setEditChild(c=>({...c,emoji:e.target.value}))} style={{...INP,width:60}}/>
                        {editChild.avatar&&<button onClick={()=>setEditChild(c=>({...c,avatar:undefined}))}
                          style={{padding:"5px 9px",border:`1px solid ${R}`,borderRadius:8,background:"transparent",color:R,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>
                          写真を削除
                        </button>}
                      </div>
                    </div>
                  </div>
                  <input value={editChild.name} onChange={e=>setEditChild(c=>({...c,name:e.target.value}))} placeholder="なまえ" style={{...INP,marginBottom:8}}/>
                  <input value={editChild.pin} onChange={e=>setEditChild(c=>({...c,pin:e.target.value.slice(0,4)}))} type="number" placeholder="暗証番号（4けた）" style={{...INP,marginBottom:8}}/>
                  {editChild.pin.length!==4 && <p style={{color:R,fontSize:11,margin:"0 0 8px"}}>4けたで入力してください</p>}
                  {/* ロック設定 */}
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,padding:"8px 12px",background:BG,borderRadius:10}}>
                    <span style={{color:MUTED,fontSize:12,fontWeight:700,flex:1}}>暗証番号ロック</span>
                    <button onClick={()=>setEditChild(c=>({...c,lockEnabled:!c.lockEnabled}))}
                      style={{background:editChild.lockEnabled?G:BORDER,border:"none",borderRadius:20,width:44,height:24,cursor:"pointer",position:"relative",transition:"background .2s"}}>
                      <div style={{position:"absolute",top:3,left:editChild.lockEnabled?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                    </button>
                    <span style={{color:editChild.lockEnabled?G:MUTED,fontSize:11,fontWeight:700}}>{editChild.lockEnabled?"ON":"OFF"}</span>
                  </div>
                  <div style={{display:"flex",gap:6,marginBottom:10}}>
                    {Object.entries(AGE_MODES).map(([k,v])=>(
                      <button key={k} onClick={()=>setEditChild(c=>({...c,ageMode:k}))}
                        style={{flex:1,padding:"7px 4px",border:`2px solid ${editChild.ageMode===k?P:BORDER}`,borderRadius:10,background:editChild.ageMode===k?`${P}20`:"transparent",fontWeight:800,fontSize:10,cursor:"pointer",fontFamily:F,color:editChild.ageMode===k?P:MUTED}}>
                        {v.emoji}<br/>{v.label}
                      </button>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:8}}>{sb(G,"保存",()=>{
                    // lockEnabledをdataにも反映
                    update(d=>({...d,
                      children:d.children.map(c=>c.id===editChild.id?editChild:c),
                      lockEnabled:{...(d.lockEnabled||{}),[editChild.id]:!!editChild.lockEnabled}
                    }));
                    setEditChild(null);
                  })}{sb(MUTED,"キャンセル",()=>setEditChild(null))}</div>
                </div>
              ) : (
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
                    <ChildAvatar child={child} size={40}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:800,fontSize:15}}>{child.name}</div>
                      <div style={{color:MUTED,fontSize:12}}>{AGE_MODES[child.ageMode||"middle"].emoji} {AGE_MODES[child.ageMode||"middle"].label} · {bal(data.logs,child.id).toLocaleString()}pt</div>
                    </div>
                    <div style={{display:"flex",gap:6}}>{sb(B,"✏",()=>setEditChild({...child,lockEnabled:!!(data.lockEnabled&&data.lockEnabled[child.id])}))}
                    {sb(R,"🗑",()=>setDelChild(child.id))}</div>
                  </div>
                  <div style={{background:BG,borderRadius:10,padding:"7px 12px",display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:14}}>🔐</span>
                    <span style={{color:MUTED,fontSize:11,fontWeight:700}}>暗証番号ロック:</span>
                    <span style={{fontWeight:800,fontSize:12,color:data.lockEnabled&&data.lockEnabled[child.id]?G:MUTED}}>
                      {data.lockEnabled&&data.lockEnabled[child.id]?"ON（{child.pin}）":"OFF（ロックなし）"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
          {showAddChild && (
            <div style={{background:`${G}12`,border:`2px dashed ${G}`,borderRadius:18,padding:16}}>
              <p style={{fontWeight:800,fontSize:13,color:G,margin:"0 0 12px"}}>新しいこどもを追加</p>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <input value={ncEmoji} onChange={e=>setNcEmoji(e.target.value)} style={{...INP,width:56}}/>
                <input value={ncName} onChange={e=>setNcName(e.target.value)} placeholder="なまえ" style={INP}/>
              </div>
              <input value={ncPin} onChange={e=>setNcPin(e.target.value.slice(0,4))} type="number" placeholder="暗証番号（4けた）" style={{...INP,marginBottom:10}}/>
              <div style={{display:"flex",gap:6,marginBottom:12}}>
                {Object.entries(AGE_MODES).map(([k,v])=>(
                  <button key={k} onClick={()=>setNcMode(k)}
                    style={{flex:1,padding:"7px 4px",border:`2px solid ${ncMode===k?P:BORDER}`,borderRadius:10,background:ncMode===k?`${P}20`:"transparent",fontWeight:800,fontSize:10,cursor:"pointer",fontFamily:F,color:ncMode===k?P:MUTED}}>
                    {v.emoji}<br/>{v.label}
                  </button>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={addChild} disabled={!ncName||ncPin.length!==4} style={{background:ncName&&ncPin.length===4?G:BORDER,border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>追加する</button>
                {sb(MUTED,"キャンセル",()=>setShowAddChild(false))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TASKS */}
      {tab==="tasks" && (
        <div style={{padding:16}}>
          {overModal && (
            <div style={{position:"fixed",inset:0,background:"#0008",zIndex:800,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
              <div style={{background:CARD,borderRadius:20,padding:24,width:"100%",maxWidth:340,fontFamily:F}}>
                <h3 style={{fontWeight:900,fontSize:16,margin:"0 0 4px"}}>{overModal.task.emoji} {overModal.task.label}</h3>
                <p style={{color:MUTED,fontSize:12,margin:"0 0 16px"}}>こどもごとに金額を個別設定（空欄=デフォルト {overModal.task.pts}円）</p>
                {data.children.map(child=>(
                  <div key={child.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <span style={{fontSize:20}}>{child.emoji}</span>
                    <span style={{fontWeight:700,fontSize:14,flex:1}}>{child.name}</span>
                    <input type="number" placeholder={`${overModal.task.pts}`}
                      value={overModal.task.over?.[child.id]??""} onChange={e=>setOver(overModal.task.id,overModal.kind,child.id,e.target.value)}
                      style={{...INP,width:100,padding:"6px 8px",fontSize:13}}/>
                  </div>
                ))}
                <button onClick={()=>setOverModal(null)} style={{marginTop:12,width:"100%",background:G,border:"none",borderRadius:10,padding:11,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>完了</button>
              </div>
            </div>
          )}
          {[["good","✅ いいこと（プラス）",G],["bad","❌ わるいこと（マイナス）",R]].map(([kind,title,color])=>{
            const tasks=kind==="good"?data.goodTasks:data.badTasks;
            const k=kind==="good"?"goodTasks":"badTasks";
            return (
              <div key={kind} style={{marginBottom:24}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>{title}</p>
                  <Btn c={color} label="＋ 追加" onClick={()=>{setNewTask({kind});setNtLabel("");setNtEmoji("⭐");setNtPts("");}} sm/>
                </div>
                {tasks.map(task=>(
                  <div key={task.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"10px 13px",marginBottom:8}}>
                    {editTask?.id===task.id ? (
                      <div>
                        <div style={{display:"flex",gap:8,marginBottom:8}}>
                          <input value={editTask.emoji} onChange={e=>setEditTask(t=>({...t,emoji:e.target.value}))} style={{...INP,width:56}}/>
                          <input value={editTask.label} onChange={e=>setEditTask(t=>({...t,label:e.target.value}))} style={INP}/>
                        </div>
                        <input value={editTask.pts} onChange={e=>setEditTask(t=>({...t,pts:e.target.value}))} type="number" placeholder="デフォルトpt数" style={{...INP,marginBottom:8}}/>
                        <div style={{display:"flex",gap:8}}>{sb(G,"保存",saveTask)}{sb(MUTED,"キャンセル",()=>setEditTask(null))}</div>
                      </div>
                    ) : (
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <span style={{fontSize:20}}>{task.emoji}</span>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:700,fontSize:14}}>{task.label}</div>
                          <div style={{color:MUTED,fontSize:11}}>デフォルト: {task.pts}pt{Object.keys(task.over||{}).length>0&&<span style={{color:P}}> · 個別設定あり</span>}</div>
                        </div>
                        <div style={{display:"flex",gap:5}}>
                          <button onClick={()=>setOverModal({task:{...task,over:{...(task.over||{})}},kind})} style={{background:`${P}18`,border:`1px solid ${P}`,borderRadius:7,padding:"3px 7px",color:P,fontWeight:700,fontSize:10,cursor:"pointer",fontFamily:F}}>個別</button>
                          {sb(B,"✏",()=>setEditTask({...task,pts:String(task.pts)}))}
                          {sb(R,"🗑",()=>delTask(kind,task.id))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {newTask?.kind===kind && (
                  <div style={{background:`${color}12`,border:`2px dashed ${color}`,borderRadius:14,padding:14,marginTop:8}}>
                    <div style={{display:"flex",gap:8,marginBottom:8}}>
                      <input value={ntEmoji} onChange={e=>setNtEmoji(e.target.value)} style={{...INP,width:56}} placeholder="絵文字"/>
                      <input value={ntLabel} onChange={e=>setNtLabel(e.target.value)} placeholder="タスク名（例：皿洗い）" style={INP}/>
                    </div>
                    <input value={ntPts} onChange={e=>setNtPts(e.target.value)} type="number" placeholder={`ポイント数（例：${kind==="good"?"30":"-50"}）`} style={{...INP,marginBottom:6}}/>
                    {ntPts&&isNaN(parseInt(ntPts))&&<p style={{color:R,fontSize:11,margin:"0 0 6px"}}>数字で入力してください</p>}
                    {(!ntLabel||!ntPts)&&<p style={{color:MUTED,fontSize:11,margin:"0 0 6px"}}>タスク名とポイント数を入力してください</p>}
                    <div style={{display:"flex",gap:8}}>{sb(color,"✅ 追加する",addTask,!ntLabel||!ntPts||isNaN(parseInt(ntPts)))}{sb(MUTED,"キャンセル",()=>setNewTask(null))}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* DAILY TASKS MANAGEMENT */}
      {tab==="daily" && <ParentDailyTab data={data} update={update} sb={sb}/>}

      {/* REWARDS */}
      {tab==="rewards" && (
        <div style={{padding:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>こうかん特典の管理</p>
            <Btn c={P} label="＋ 追加" onClick={()=>setShowAddReward(true)} sm/>
          </div>
          {data.rewards.map(r=>(
            <div key={r.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"10px 13px",marginBottom:8}}>
              {editReward?.id===r.id ? (
                <div>
                  <div style={{display:"flex",gap:8,marginBottom:8}}>
                    <input value={editReward.emoji} onChange={e=>setEditReward(v=>({...v,emoji:e.target.value}))} style={{...INP,width:56}}/>
                    <input value={editReward.label} onChange={e=>setEditReward(v=>({...v,label:e.target.value}))} style={INP}/>
                  </div>
                  <input value={editReward.cost} onChange={e=>setEditReward(v=>({...v,cost:e.target.value}))} type="number" style={{...INP,marginBottom:8}}/>
                  <input value={editReward.unit} onChange={e=>setEditReward(v=>({...v,unit:e.target.value}))} style={{...INP,marginBottom:10}}/>
                  <div style={{display:"flex",gap:8}}>{sb(G,"保存",saveReward)}{sb(MUTED,"キャンセル",()=>setEditReward(null))}</div>
                </div>
              ) : (
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  {/^r0\d$/.test(r.id)?<img src={`/assets/reward_${r.id}.png`} style={{width:30,height:30,objectFit:"contain",borderRadius:6,flexShrink:0}} alt=""/>:<span style={{fontSize:22}}>{r.emoji}</span>}
                  <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14}}>{r.label}</div><div style={{color:MUTED,fontSize:12}}>{r.unit}</div></div>
                  <span style={{fontWeight:800,color:P,marginRight:6}}>{r.cost.toLocaleString()}pt</span>
                  <div style={{display:"flex",gap:5}}>{sb(B,"✏",()=>setEditReward({...r,cost:String(r.cost)}))}{sb(R,"🗑",()=>delReward(r.id))}</div>
                </div>
              )}
            </div>
          ))}
          {showAddReward && (
            <div style={{background:`${P}12`,border:`2px dashed ${P}`,borderRadius:14,padding:14,marginTop:8}}>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <input value={nrEmoji} onChange={e=>setNrEmoji(e.target.value)} style={{...INP,width:56}}/>
                <input value={nrLabel} onChange={e=>setNrLabel(e.target.value)} placeholder="特典名" style={INP}/>
              </div>
              <input value={nrCost} onChange={e=>setNrCost(e.target.value)} type="number" placeholder="必要ポイント（pt）" style={{...INP,marginBottom:8}}/>
              <input value={nrUnit} onChange={e=>setNrUnit(e.target.value)} placeholder="内容説明（例: 30分延長）" style={{...INP,marginBottom:10}}/>
              <div style={{display:"flex",gap:8}}>{sb(P,"追加する",addReward)}{sb(MUTED,"キャンセル",()=>setShowAddReward(false))}</div>
            </div>
          )}
        </div>
      )}

      {/* KAKEIBO picker */}
      {tab==="kakeibo" && (
        <div style={{padding:16}}>
          <p style={{color:MUTED,fontSize:13,fontWeight:800,marginBottom:12}}>💸 こどもを選んでください</p>
          {data.children.map(child=>(
            <button key={child.id} onClick={()=>setKChild(child.id)}
              style={{width:"100%",background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:"13px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:14,cursor:"pointer",textAlign:"left",fontFamily:F}}>
              <span style={{fontSize:32}}>{child.emoji}</span>
              <div style={{flex:1}}>
                <div style={{fontWeight:800,fontSize:15}}>{child.name}</div>
                <div style={{color:MUTED,fontSize:12}}>今月支出: {(data.expenses||[]).filter(e=>e.cid===child.id&&(e.date||"").startsWith(monthKey())).reduce((s,e)=>s+e.amt,0).toLocaleString()}pt</div>
              </div>
              <span style={{color:MUTED,fontSize:22}}>›</span>
            </button>
          ))}
          {/* category settings */}
          <div style={{paddingTop:16,borderTop:`2px solid ${BORDER}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>カテゴリ設定</p>
              <Btn c={B} label="＋" onClick={()=>setShowAddCat(true)} sm/>
            </div>
            {(data.cats||[]).map(cat=>(
              <div key={cat.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"8px 12px",marginBottom:7}}>
                {editCat?.id===cat.id ? (
                  <div>
                    <div style={{display:"flex",gap:8,marginBottom:8}}>
                      <input value={editCat.emoji} onChange={e=>setEditCat(c=>({...c,emoji:e.target.value}))} style={{...INP,width:56}}/>
                      <input value={editCat.label} onChange={e=>setEditCat(c=>({...c,label:e.target.value}))} style={INP}/>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                      <span style={{fontSize:12,color:MUTED,fontWeight:700}}>カラー:</span>
                      <input type="color" value={editCat.color} onChange={e=>setEditCat(c=>({...c,color:e.target.value}))} style={{width:44,height:30,border:"none",cursor:"pointer"}}/>
                    </div>
                    <div style={{display:"flex",gap:8}}>{sb(G,"保存",saveCat)}{sb(MUTED,"キャンセル",()=>setEditCat(null))}</div>
                  </div>
                ) : (
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:cat.color,flexShrink:0}}/>
                    <span style={{fontSize:16}}>{cat.emoji}</span>
                    <span style={{flex:1,fontWeight:700,fontSize:13}}>{cat.label}</span>
                    <div style={{display:"flex",gap:5}}>{sb(B,"✏",()=>setEditCat({...cat}))}{sb(R,"🗑",()=>delCat(cat.id))}</div>
                  </div>
                )}
              </div>
            ))}
            {showAddCat && (
              <div style={{background:`${B}12`,border:`2px dashed ${B}`,borderRadius:12,padding:14,marginTop:8}}>
                <div style={{display:"flex",gap:8,marginBottom:8}}>
                  <input value={ncatEmoji} onChange={e=>setNcatEmoji(e.target.value)} style={{...INP,width:56}}/>
                  <input value={ncatLabel} onChange={e=>setNcatLabel(e.target.value)} placeholder="カテゴリ名" style={INP}/>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                  <span style={{fontSize:12,color:MUTED,fontWeight:700}}>カラー:</span>
                  <input type="color" value={ncatColor} onChange={e=>setNcatColor(e.target.value)} style={{width:44,height:30,border:"none",cursor:"pointer"}}/>
                </div>
                <div style={{display:"flex",gap:8}}>{sb(B,"追加する",addCat)}{sb(MUTED,"キャンセル",()=>setShowAddCat(false))}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* GACHA settings */}
      {tab==="gacha" && (
        <div style={{padding:16}}>
          <div style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:16,marginBottom:16}}>
            <p style={{fontWeight:900,fontSize:14,margin:"0 0 4px"}}>🎰 デイリーガチャ設定</p>
            <p style={{color:MUTED,fontSize:12,margin:"0 0 14px"}}>出現率の合計を100%にしてください。</p>
            {!gachaEdit ? (
              <>
                {data.gacha.map(g=>(
                  <div key={g.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:`1px solid ${BORDER}`}}>
                    <span style={{fontSize:18}}>{g.emoji}</span>
                    <div style={{flex:1}}><div style={{fontWeight:800,fontSize:13,color:g.color}}>{g.label}</div><div style={{color:MUTED,fontSize:11}}>{g.min}〜{g.max}pt</div></div>
                    <span style={{background:`${g.color}20`,color:g.color,fontWeight:800,fontSize:11,padding:"2px 9px",borderRadius:20}}>{g.rate}%</span>
                  </div>
                ))}
                <button onClick={()=>setGachaEdit(JSON.parse(JSON.stringify(data.gacha)))} style={{marginTop:14,background:Y,border:"none",borderRadius:10,padding:"10px 0",width:"100%",fontWeight:800,fontSize:14,color:TEXT,cursor:"pointer",fontFamily:F}}>✏ 設定を変更する</button>
              </>
            ) : (
              <>
                <p style={{color:gachaEdit.reduce((s,g)=>s+Number(g.rate),0)===100?G:R,fontSize:12,fontWeight:700,marginBottom:12}}>合計: {gachaEdit.reduce((s,g)=>s+Number(g.rate),0)}% / 100%</p>
                {gachaEdit.map((g,i)=>(
                  <div key={g.id} style={{background:`${g.color}10`,border:`1.5px solid ${g.color}40`,borderRadius:12,padding:12,marginBottom:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:g.color,marginBottom:8}}>{g.emoji} {g.label}</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                      {[["出現率(%)","rate"],["最小(pt)","min"],["最大(pt)","max"]].map(([lbl,key])=>(
                        <div key={key}>
                          <p style={{color:MUTED,fontSize:10,margin:"0 0 3px"}}>{lbl}</p>
                          <input value={g[key]} type="number" onChange={e=>{const c=[...gachaEdit];c[i]={...c[i],[key]:e.target.value};setGachaEdit(c);}} style={{...INP,padding:"6px 8px",fontSize:13}}/>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <button onClick={saveGacha} style={{flex:1,background:G,border:"none",borderRadius:10,padding:11,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>✅ 保存する</button>
                  <button onClick={()=>setGachaEdit(null)} style={{flex:1,background:MUTED,border:"none",borderRadius:10,padding:11,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>キャンセル</button>
                </div>
              </>
            )}
          </div>
          <p style={{color:MUTED,fontSize:13,fontWeight:800,marginBottom:8}}>今日のガチャ状況</p>
          {data.children.map(child=>{
            const done=data.gachaDate?.[child.id]===todayKey();
            return (
              <div key={child.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"11px 13px",marginBottom:8,display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:26}}>{child.emoji}</span>
                <span style={{flex:1,fontWeight:700,fontSize:14}}>{child.name}</span>
                <span style={{fontWeight:800,fontSize:12,color:done?G:MUTED}}>{done?"✅ 引き済み":"⏳ まだ"}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── ファミリータブ（FamilyGuardianScreen埋め込み） ── */}
      {tab==="family" && (
        <FamilyGuardianScreen
          data={data}
          onBack={()=>setTab("overview")}
          onPublicView={()=>{
            // App側のscreen管理でfamily_publicへ遷移（ここでは無効化）
            setTab("overview");
          }}
        />
      )}

      {/* ── 学ぶタブ（親向け投資・為替） ── */}
      {tab==="learn" && (
        <InvestLearnTab
          child={(data.parents||[])[0]||{id:"p1",name:"パパ",emoji:"👨",permissions:{investment:"trade",forex:"trade"}}}
          data={data}
          update={update}
          onRanking={()=>setTab("overview")}
        />
      )}

      {/* LOG */}
      {tab==="log" && (
        <div style={{padding:16}}>
          {data.children.map(child=>{
            const logs=data.logs.filter(l=>l.cid===child.id).slice(0,20);
            return (
              <div key={child.id} style={{marginBottom:24}}>
                <p style={{fontWeight:800,fontSize:13,color:MUTED,marginBottom:8}}>{child.emoji} {child.name}　<span style={{color:G}}>{bal(data.logs,child.id).toLocaleString()}pt</span></p>
                {logs.map(l=>{
                  const emoji=l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":([...data.goodTasks,...data.badTasks].find(t=>t.id===l.rid)?.emoji||"📌");
                  return (
                    <div key={l.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 13px",marginBottom:6,display:"flex",alignItems:"center",gap:10}}>
                      <span style={{fontSize:17}}>{emoji}</span>
                      <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{l.label}</div><div style={{color:MUTED,fontSize:10}}>{fmtDate(l.date)}</div></div>
                      <Pt v={l.pts}/>
                    </div>
                  );
                })}
                {logs.length===0 && <p style={{color:MUTED,fontSize:12,textAlign:"center"}}>まだ履歴がありません</p>}
              </div>
            );
          })}
        </div>
      )}

      {/* ── AI分析タブ ── */}
      {tab==="ai" && <AiAdvisorTab data={data}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════════════════
function HomeScreen({ data, update, onChild, onParent, onParentCard }) {
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboardGuide, setShowOnboardGuide] = useState(false);
  const allMembers = [
    ...data.children.map(c=>({...c, isChild:true})),
    ...(data.parents||[]).map(p=>({...p, isChild:false})),
  ];
  const thisMonth = new Date().toISOString().slice(0,7);
  const monthDelta = (memberId) => {
    return (data.logs||[])
      .filter(l=>l.cid===memberId && (l.date||"").startsWith(thisMonth))
      .reduce((s,l)=>s+l.pts,0);
  };
  const todayDelta = (memberId) => {
    const td = todayKey();
    return (data.logs||[])
      .filter(l=>l.cid===memberId && (l.date||"").startsWith(td) && l.pts>0)
      .reduce((s,l)=>s+l.pts,0);
  };
  const topGoal = (memberId) => {
    const goals=(data.goals||[]).filter(g=>g.cid===memberId&&!g.done);
    if(!goals.length) return null;
    const g=goals[0];
    const cur=bal(data.logs,memberId);
    const pct=Math.min(100,Math.floor(cur/g.target*100));
    return{label:g.label,pct,target:g.target};
  };

  const onboardChecks = {
    pin: data.parentPin !== "0000",
    tasks: !!(data.onboardingChecks?.tasksOpened),
    rewards: !!(data.onboardingChecks?.rewardsOpened),
  };
  const onboardRemaining = Object.values(onboardChecks).filter(v=>!v).length;
  const showOnboard = data.setupComplete === true && onboardRemaining > 0;

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:32}}>
      {/* ヘッダー */}
      <div style={{padding:"52px 20px 28px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:28}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:40,height:40,borderRadius:12,background:GP,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,boxShadow:`0 4px 12px ${GP}40`}}>🌱</div>
            <div>
              <div style={{fontFamily:FB,fontWeight:900,fontSize:19,color:GP,letterSpacing:.5}}>Tane Money</div>
              <div style={{fontSize:10,color:MUTED,letterSpacing:.3}}>お金は、未来を育てるタネ。</div>
            </div>
          </div>
          <button onClick={()=>setShowSettings(true)}
            style={{width:38,height:38,borderRadius:11,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",boxShadow:"0 2px 8px rgba(24,35,29,0.05)",position:"relative"}}>
            ⚙
            {data.parentPin==="0000"&&<div style={{position:"absolute",top:-4,right:-4,width:10,height:10,borderRadius:"50%",background:R,border:"2px solid #fff"}}/>}
          </button>
        </div>
        <div style={{fontSize:13,fontWeight:700,color:TEXT}}>メンバーを選択</div>
      </div>

      <div style={{padding:"0 20px"}}>
        {/* 子ども */}
        <div style={{fontSize:10,fontWeight:700,color:MUTED,letterSpacing:1,marginBottom:10,textTransform:"uppercase"}}>Child</div>
        {allMembers.filter(m=>m.isChild).map(member=>{
          const goal=topGoal(member.id);
          return (
            <button key={member.id} onClick={()=>onChild(member)}
              style={{width:"100%",background:CARD,border:`1px solid ${BORDER}`,borderRadius:20,padding:"14px 16px",marginBottom:10,display:"block",textAlign:"left",cursor:"pointer",fontFamily:F,boxShadow:"0 4px 16px rgba(24,35,29,0.06)"}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:goal?12:0}}>
                <ChildAvatar child={member} size={44}/>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    <span style={{fontWeight:700,fontSize:15,color:TEXT}}>{member.name}</span>
                    <span style={{fontSize:10,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:600}}>Child</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,color:MUTED}}>{member.gradeLabel||"中高生"}</span>
                    <span style={{fontSize:10,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:700}}>累計 {bal(data.logs,member.id).toLocaleString()}pt</span>
                    {(()=>{const td=todayDelta(member.id);return td>0&&<span style={{fontSize:10,background:GOLDS,color:GOLD,padding:"2px 7px",borderRadius:999,fontWeight:700}}>今日 +{td}pt</span>;})()}
                  </div>
                </div>
                <ChevronRightIcon/>
              </div>
              {goal&&(
                <div style={{background:BG,borderRadius:10,padding:"8px 12px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontSize:11,color:TEXTS,fontWeight:600}}>{goal.label}</span>
                    <span style={{fontSize:11,fontWeight:700,color:GP}}>{goal.pct}%</span>
                  </div>
                  <div style={{background:BORDER,borderRadius:999,height:5,overflow:"hidden"}}>
                    <div style={{width:`${goal.pct}%`,height:"100%",background:G,borderRadius:999}}/>
                  </div>
                </div>
              )}
            </button>
          );
        })}

        {/* 親 */}
        {allMembers.filter(m=>!m.isChild).length>0&&(
          <div style={{fontSize:10,fontWeight:700,color:MUTED,letterSpacing:1,margin:"16px 0 10px",textTransform:"uppercase"}}>Parent</div>
        )}
        {allMembers.filter(m=>!m.isChild).map(member=>{
          const childCount = data.children.length;
          const monthTotal = data.children.reduce((s,c)=>s+monthDelta(c.id),0);
          return (
          <button key={member.id} onClick={()=>onParentCard(member)}
            style={{width:"100%",background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:"14px 16px",marginBottom:8,display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left",fontFamily:F,boxShadow:"0 4px 16px rgba(24,35,29,0.06)"}}>
            <ChildAvatar child={member} size={44}/>
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <span style={{fontWeight:700,fontSize:14,color:TEXT}}>{member.name}</span>
                <span style={{fontSize:10,background:CARDS,color:TEXTS,padding:"2px 7px",borderRadius:999,fontWeight:600}}>Parent</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:MUTED}}>子ども {childCount}人</span>
                <span style={{fontSize:10,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:700}}>今月計 {monthTotal.toLocaleString()}pt</span>
              </div>
            </div>
            <ChevronRightIcon/>
          </button>
          );
        })}

        {/* 同期 */}
        <div style={{marginTop:24,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",background:CARD,borderRadius:12,border:`1px solid ${BORDER}`}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:G}}/>
            <span style={{fontSize:11,color:TEXTS}}>同期済み</span>
          </div>
          <span style={{fontSize:11,color:MUTED,letterSpacing:1.5,fontWeight:700}}>
            {(()=>{try{return localStorage.getItem("tane_money_family_code")||"---";}catch(e){return "---";}})()}
          </span>
        </div>
      </div>

      {/* 初心者ガイド 浮きボタン（LINE Farm風） */}
      {showOnboard&&(
        <div style={{position:"fixed",left:10,top:220,zIndex:500}}>
          <button onClick={()=>setShowOnboardGuide(true)} style={{background:CARD,border:`2px solid ${GP}`,borderRadius:20,padding:"10px 7px",boxShadow:`0 4px 18px ${GP}30`,display:"flex",flexDirection:"column",alignItems:"center",gap:3,cursor:"pointer",fontFamily:F,position:"relative",width:54}}>
            {onboardRemaining>0&&<div style={{position:"absolute",top:-7,right:-7,width:20,height:20,borderRadius:"50%",background:R,color:"#fff",fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",border:"2px solid #fff"}}>{onboardRemaining}</div>}
            <span style={{fontSize:22}}>📋</span>
            <span style={{fontSize:8,fontWeight:800,color:GP,lineHeight:1.3,textAlign:"center"}}>初心者<br/>ガイド</span>
          </button>
        </div>
      )}

      {/* 初心者ガイド モーダル */}
      {showOnboardGuide&&(
        <div style={{position:"fixed",inset:0,background:"#0008",zIndex:9100,display:"flex",alignItems:"flex-end",fontFamily:F}} onClick={()=>setShowOnboardGuide(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:CARD,borderRadius:"24px 24px 0 0",width:"100%",padding:"24px 20px 48px",boxShadow:"0 -8px 32px rgba(24,35,29,0.12)"}}>
            <div style={{width:36,height:4,borderRadius:999,background:BORDER,margin:"0 auto 16px"}}/>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
              <span style={{fontSize:22}}>📋</span>
              <h3 style={{fontWeight:900,fontSize:17,color:TEXT,margin:0}}>初心者ガイド</h3>
              {onboardRemaining>0&&<span style={{background:R,color:"#fff",borderRadius:999,padding:"2px 9px",fontSize:11,fontWeight:900}}>{onboardRemaining}つ残り</span>}
            </div>
            <p style={{color:MUTED,fontSize:12,margin:"0 0 18px"}}>最初に設定しておくと安心！</p>
            {[
              {key:"pin",emoji:"🔐",title:"PINを変更する",desc:"おや管理 → 詳細設定 → PIN タブ",done:onboardChecks.pin,
               action:()=>{setShowOnboardGuide(false);onParent();}},
              {key:"tasks",emoji:"📋",title:"タスクを確認する",desc:"おや管理 → 詳細設定 → タスク タブ",done:onboardChecks.tasks,
               action:()=>{if(update)update(d=>({...d,onboardingChecks:{...(d.onboardingChecks||{}),tasksOpened:true}}));setShowOnboardGuide(false);onParent();}},
              {key:"rewards",emoji:"🎁",title:"特典を確認する",desc:"おや管理 → 詳細設定 → 特典 タブ",done:onboardChecks.rewards,
               action:()=>{if(update)update(d=>({...d,onboardingChecks:{...(d.onboardingChecks||{}),rewardsOpened:true}}));setShowOnboardGuide(false);onParent();}},
            ].map(item=>(
              <div key={item.key} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 0",borderBottom:`1px solid ${BORDER}`}}>
                <div style={{width:44,height:44,borderRadius:14,background:item.done?GS:BG,border:`2px solid ${item.done?G:BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
                  {item.done?"✅":item.emoji}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,color:item.done?MUTED:TEXT,textDecoration:item.done?"line-through":"none"}}>{item.title}</div>
                  <div style={{fontSize:11,color:MUTED,marginTop:2}}>{item.desc}</div>
                </div>
                {!item.done&&<button onClick={item.action} style={{padding:"8px 14px",background:GP,border:"none",borderRadius:10,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,flexShrink:0}}>開く →</button>}
              </div>
            ))}
            <button onClick={()=>setShowOnboardGuide(false)} style={{width:"100%",marginTop:16,padding:"11px",background:"transparent",border:`1.5px solid ${BORDER}`,borderRadius:12,color:MUTED,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
              後で確認する
            </button>
          </div>
        </div>
      )}

      {/* 設定モーダル */}
      {showSettings&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:999,display:"flex",alignItems:"flex-end",fontFamily:F}} onClick={()=>setShowSettings(false)}>
          <div style={{background:CARD,borderRadius:"24px 24px 0 0",width:"100%",padding:"24px 20px 48px",boxShadow:"0 -8px 32px rgba(24,35,29,0.10)"}} onClick={e=>e.stopPropagation()}>
            <div style={{width:36,height:4,borderRadius:999,background:BORDER,margin:"0 auto 20px"}}/>
            <h3 style={{fontWeight:800,fontSize:17,margin:"0 0 16px",color:TEXT}}>設定</h3>
            <button onClick={()=>{setShowSettings(false);onParent();}}
              style={{width:"100%",background:GP,border:"none",borderRadius:14,padding:"14px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:F,marginBottom:10}}>
              🔐 おや管理（PIN認証）
            </button>
            <div style={{background:BG,borderRadius:14,padding:"12px 16px",marginBottom:10}}>
              <p style={{color:MUTED,fontSize:11,fontWeight:600,margin:"0 0 3px",letterSpacing:.5}}>FAMILY CODE</p>
              <p style={{fontWeight:800,fontSize:15,color:TEXT,margin:0,letterSpacing:2.5}}>
                {(()=>{try{return localStorage.getItem("tane_money_family_code")||"---";}catch(e){return "---";}})()}
              </p>
            </div>
            <p style={{color:MUTED,fontSize:11,textAlign:"center",margin:0}}>初期PIN：れいか＝1111、かなと＝2222、おや＝0000</p>
          </div>
        </div>
      )}
    </div>
  );
}

// 小さなシェブロン右
function ChevronRightIcon(){
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>;
}


function PinResetScreen({ data, update, onBack }) {
  const [target, setTarget] = useState(null);
  const [newPin, setNewPin]  = useState("");

  const doReset = () => {
    if (newPin.length!==4) return;
    if (target==="parent") update(d=>({...d,parentPin:newPin}));
    else update(d=>({...d,children:d.children.map(c=>c.id===target?{...c,pin:newPin}:c)}));
    onBack();
  };

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,position:"relative"}}>
      <button onClick={onBack} style={{position:"absolute",top:20,left:20,background:"none",border:"none",fontSize:28,cursor:"pointer",color:MUTED}}>‹</button>
      <div style={{fontSize:46,marginBottom:8}}>🔑</div>
      <h2 style={{fontWeight:900,fontSize:20,margin:"0 0 6px"}}>PINを再設定</h2>
      <p style={{color:MUTED,fontSize:12,marginBottom:22,textAlign:"center"}}>変更するアカウントを選んでください</p>
      <div style={{width:"100%",maxWidth:340,marginBottom:18}}>
        {[{id:"parent",name:"おや管理画面",emoji:"🔐"},...data.children].map(item=>(
          <button key={item.id} onClick={()=>setTarget(item.id)}
            style={{width:"100%",background:target===item.id?"#fef9e0":CARD,border:`2px solid ${target===item.id?Y:BORDER}`,borderRadius:14,padding:"11px 15px",marginBottom:8,display:"flex",alignItems:"center",gap:12,cursor:"pointer",fontFamily:F}}>
            <span style={{fontSize:26}}>{item.emoji}</span>
            <span style={{fontWeight:800,fontSize:14}}>{item.name}</span>
          </button>
        ))}
      </div>
      {target && (
        <div style={{width:"100%",maxWidth:340}}>
          <p style={{color:MUTED,fontSize:13,fontWeight:700,marginBottom:8}}>新しい暗証番号（4けた）</p>
          <input value={newPin} onChange={e=>setNewPin(e.target.value.slice(0,4))} type="number" placeholder="0000" style={{...INP,marginBottom:14,fontSize:22,textAlign:"center",letterSpacing:10}}/>
          <Btn c={G} label="✅ 保存する" onClick={doReset} disabled={newPin.length!==4} full/>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// APP ROOT
// ═══════════════════════════════════════════════════════
// Child avatar: photo or emoji

// ── SortBar ──────────────────────────────────────────
function SortBar({options,value,onChange}){
  return(<div style={{display:"flex",gap:6,overflowX:"auto",scrollbarWidth:"none",padding:"0 0 2px"}}>
    {options.map(([v,l])=>(
      <button key={v} onClick={()=>onChange(v)}
        style={{flex:"0 0 auto",padding:"5px 11px",border:`1.5px solid ${value===v?TEXT:BORDER}`,borderRadius:20,background:value===v?TEXT:"transparent",color:value===v?"#fff":MUTED,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap"}}>
        {l}
      </button>
    ))}
  </div>);
}

// ── Interest System ───────────────────────────────────
function applyInterest(data,update,cid){
  const today=todayKey();
  if(!data.interestEnabled||!data.interestRate) return;
  if((data.interestLastDate||{})[cid]===today) return;
  if((data.interestLastDate||{})[cid]){
    const diff=(new Date(today.replace(/-/g,'/'))-new Date((data.interestLastDate[cid]).replace(/-/g,'/')))/86400000;
    if(diff<7) return;
  }
  const cur=bal(data.logs,cid);
  if(cur<=0) return;
  const interest=Math.floor(cur*data.interestRate);
  if(interest<=0) return;
  update(d=>({...d,
    logs:(()=>{const _e={id:uid(),cid,type:"interest",label:`💹 週次利子（残高×${Math.round(d.interestRate*100)}%）`,pts:interest,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})(),
    interestLastDate:{...(d.interestLastDate||{}),[cid]:today},
  }));
}

// ── Long-term Holding Bonus（30日以上保有で月3%） ─────
function applyHoldingBonus(data,update,cid){
  const thisMonth=new Date().toISOString().slice(0,7);
  if((data.holdBonusLastDate||{})[cid]===thisMonth) return;
  const holdings=(data.holdings||{})[cid]||[];
  if(!holdings.length) return;
  const stocks=data.stocks||[];
  const toPts=(s,p)=>s.currency==="USD"?Math.max(1,Math.round(p*1.5)):Math.max(1,Math.round(p/100));
  const now=new Date();
  let totalBonus=0;
  holdings.forEach(h=>{
    if(!h.firstBuyDate) return;
    const days=(now-new Date(h.firstBuyDate))/86400000;
    if(days<30) return;
    const st=stocks.find(x=>x.id===h.stockId);
    if(!st) return;
    totalBonus+=Math.floor(toPts(st,st.price)*h.qty*0.03);
  });
  if(totalBonus<=0) return;
  update(d=>({...d,
    logs:(()=>{const _e={id:uid(),cid,type:"interest",label:`📦 長期保有ボーナス（30日以上×3%）`,pts:totalBonus,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})(),
    holdBonusLastDate:{...(d.holdBonusLastDate||{}),[cid]:thisMonth},
  }));
}

// ── Stock News & Fetch ────────────────────────────────
const STOCK_NEWS={
  "7974.T":["新作スイッチソフトが大ヒット！","為替の影響で利益が変動","海外市場での販売好調","次世代機の噂が広まる","人気IPの新作発表"],
  "6758.T":["PlayStation新作が世界トップセールス","半導体不足が解消に向かう","映画・音楽部門が好調","円安でドル収益が増加","AI技術への投資を発表"],
  "7203.T":["EV新モデルが好評","半導体供給が安定化","米国市場でシェア拡大","環境対応で補助金獲得","新工場の建設を発表"],
  "MCD":["新メニューが世界的にヒット","原材料コストが上昇","デジタル注文が急増","アジア市場での出店加速","健康志向メニューを拡充"],
  "AAPL":["iPhone新モデルが記録的売上","インドでの生産を拡大","サービス部門の収益が増加","新型Macが高評価","AIチップ搭載で注目集める"],
};

async function fetchRealStockPrices(data,update){
  const today=todayKey();
  const stockAlreadyFetched = data.stockLastUpdate===today && data.stockFetchStatus==="ok";
  // 為替は毎回取得（株は1日1回）
  update(d=>({...d,stockFetchStatus:stockAlreadyFetched?"ok":"loading"}));

  // プロキシを複数用意してフォールバック
  const fetchWithProxy = async (url, timeout=12000) => {
    const proxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ];
    for(const proxy of proxies){
      try{
        const ctrl = new AbortController();
        const timer = setTimeout(()=>ctrl.abort(), timeout);
        const r = await fetch(proxy, {signal:ctrl.signal});
        clearTimeout(timer);
        if(!r.ok) continue;
        const text = await r.text();
        if(!text || text.length < 10) continue;
        try { return JSON.parse(text); } catch(e) { continue; }
      }catch(e){ continue; }
    }
    throw new Error("All proxies failed for: " + url);
  };

  const forexMap = {}; // 為替データを蓄積

  // ── 為替レート取得（1通貨ずつ順番に・レート制限対策）──
  const FOREX_PAIRS=["USDJPY=X","EURJPY=X","GBPJPY=X","CNYJPY=X","KRWJPY=X"];
  const FOREX_LABELS={
    "USDJPY=X":{code:"USD",flag:"🇺🇸",name:"アメリカ ドル"},
    "EURJPY=X":{code:"EUR",flag:"🇪🇺",name:"ユーロ"},
    "GBPJPY=X":{code:"GBP",flag:"🇬🇧",name:"イギリス ポンド"},
    "CNYJPY=X":{code:"CNY",flag:"🇨🇳",name:"中国 人民元"},
    "KRWJPY=X":{code:"KRW",flag:"🇰🇷",name:"韓国 ウォン"},
  };
  const FOREX_FALLBACKS={
    "USDJPY=X":155,"EURJPY=X":168,"GBPJPY=X":196,"CNYJPY=X":21.4,"KRWJPY=X":0.112
  };
  // フォールバック用の30日分ダミー履歴を生成（変動させてグラフを見せる）
  const makeFallbackHistory=(base)=>{
    const h=[];
    let v=base*0.97;
    for(let i=0;i<30;i++){
      v=v*(1+(Math.random()-0.48)*0.008);
      h.push(Math.round(v*1000)/1000);
    }
    h[h.length-1]=base;
    return h;
  };

  // 1通貨ずつ順番に取得（800ms間隔でレート制限を回避）
  for(let i=0;i<FOREX_PAIRS.length;i++){
    const ticker=FOREX_PAIRS[i];
    if(i>0) await new Promise(res=>setTimeout(res,800));
    try{
      const json=await fetchWithProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=30d`);
      const meta=json?.chart?.result?.[0]?.meta;
      const closes=json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if(!meta) throw new Error("no meta");
      const valid=(closes||[]).filter(v=>v!=null).slice(-30);
      const price=meta.regularMarketPrice||valid[valid.length-1]||FOREX_FALLBACKS[ticker];
      const prev=meta.previousClose||valid[valid.length-2]||price;
      const history=valid.length>=5
        ? valid.map(v=>Math.round(v*1000)/1000)
        : makeFallbackHistory(price);
      forexMap[ticker]={
        ...FOREX_LABELS[ticker],
        price:Math.round(price*1000)/1000,
        prev:Math.round(prev*1000)/1000,
        history,
        changePct:((price-prev)/prev)*100,
        realData:true
      };
      // 取得できたら即座にupdateで反映
      const snapshot={...forexMap};
      update(d=>({...d,forex:snapshot}));
      console.log(`Forex OK: ${ticker} = ${price}`);
    }catch(e){
      const fb=FOREX_FALLBACKS[ticker];
      forexMap[ticker]={
        ...FOREX_LABELS[ticker],
        price:fb,
        prev:fb,
        history:makeFallbackHistory(fb),
        changePct:0,
        realData:false
      };
      // フォールバックも即座に反映
      const snapshot={...forexMap};
      update(d=>({...d,forex:snapshot}));
      console.warn(`Forex fallback: ${ticker}`);
    }
  }

  // ── 株価取得（1銘柄ずつ順番・1日1回）──
  const stocks = data.stocks||[];

  if(stockAlreadyFetched){
    // 株はスキップ（為替は上のループで既に随時更新済み）
    return;
  }
  const stockResults = {};

  // 並列ではなく少し間隔をあけて取得（レート制限対策）
  for(let i=0;i<stocks.length;i++){
    const s = stocks[i];
    if(i>0) await new Promise(res=>setTimeout(res,500)); // 500ms待機
    try{
      const json = await fetchWithProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${s.ticker}?interval=1d&range=30d`);
      const meta=json?.chart?.result?.[0]?.meta;
      const closes=json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if(!meta||!closes) throw new Error("No data");
      const valid=closes.filter(v=>v!=null).slice(-30);
      const price=meta.regularMarketPrice||valid[valid.length-1];
      const prev=meta.previousClose||valid[valid.length-2]||price;
      const currency=meta.currency||s.currency;
      stockResults[s.id]={
        price: currency==="JPY"?Math.round(price):Math.round(price*100)/100,
        history: valid.map(v=>currency==="JPY"?Math.round(v):Math.round(v*100)/100),
        changePct: ((price-prev)/prev)*100,
        currency, realData:true
      };
    }catch(e){
      // この銘柄は前回値を維持
      stockResults[s.id]=null;
    }
    // 取得できたものから随時update
    const currentResults = {...stockResults};
    update(d=>{
      const newStocks=(d.stocks||[]).map(st=>{
        const r=currentResults[st.id];
        if(!r) return st;
        const comments=STOCK_NEWS[st.ticker]||["市場が変動した"];
        return{...st,
          price:r.price,
          history:r.history,
          lastChange:Math.round(r.changePct*10)/10,
          lastComment:comments[Math.floor(Math.random()*comments.length)],
          currency:r.currency,
          realData:true
        };
      });
      const allDone = i===stocks.length-1;
      return{...d,
        stocks:newStocks,
        forex:forexMap,
        stockFetchStatus:allDone?"ok":"loading",
        stockLastUpdate:allDone?today:d.stockLastUpdate
      };
    });
  }
}

// ── Seed Monster ──────────────────────────────────────
function SeedMonster({ child, data, size=90, update }) {
  const [sparkles, setSparkles] = useState([]);
  const [speech, setSpeech] = useState(null);
  const [editNick, setEditNick] = useState(false);
  const [nickInput, setNickInput] = useState("");

  const myBal      = bal(data.logs, child.id);
  const curStreak  = data.streak?.[child.id]?.cur || 0;
  const thisMonth  = new Date().toISOString().slice(0,7);
  const monthPts   = (data.logs||[]).filter(l=>l.cid===child.id&&(l.date||"").startsWith(thisMonth)&&l.pts>0).reduce((s,l)=>s+l.pts,0);
  const goalsDone  = (data.goals||[]).filter(g=>g.cid===child.id&&g.done).length;
  const todayDone  = data.gachaDate?.[child.id] === todayKey();
  const hour       = new Date().getHours();
  const isSleeping = hour >= 22 || hour < 7;

  // タスク累計回数でステージ決定（お手伝い＋デイリータスク）
  const totalTasksDone = (data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")).length;
  const stage  = totalTasksDone<10?0:totalTasksDone<50?1:totalTasksDone<150?2:totalTasksDone<400?3:4;
  const NAMES  = ["タネっち","メっち","ハっち","サカっち","キングタネ"];

  const happyScore = Math.min(10,
    (curStreak>=7?3:curStreak>=3?2:curStreak>=1?1:0) +
    (monthPts>=500?3:monthPts>=200?2:monthPts>=50?1:0) +
    (goalsDone>=2?2:goalsDone>=1?1:0) +
    (todayDone?1:0) + (myBal>=1000?1:0)
  );

  const tapMsgs = happyScore>=7
    ? ["わーい！✨","うれしい〜！","ありがとう！","えへへ〜！"]
    : happyScore>=4
    ? ["いっしょにがんばろ！","きょうもよろしく！","タスクやってみよ！"]
    : ["さびしいな…","がんばって！","タッチしてくれた！"];

  const handleTap = ()=>{
    const id=Date.now();
    setSparkles(s=>[...s,{id,x:Math.random()*60-30,y:-(20+Math.random()*30)}]);
    setTimeout(()=>setSparkles(s=>s.filter(x=>x.id!==id)),800);
    setSpeech(tapMsgs[Math.floor(Math.random()*tapMsgs.length)]);
    setTimeout(()=>setSpeech(null),1800);
  };

  // 進化バー（タスク回数ベース）
  const nextTask = stage===0?10:stage===1?50:stage===2?150:stage===3?400:null;
  const prevTask = stage===0?0:stage===1?10:stage===2?50:stage===3?150:400;
  const evoPct   = nextTask ? Math.min(100,Math.round((totalTasksDone-prevTask)/(nextTask-prevTask)*100)) : 100;

  // 獲得バッジによるアクセサリーステッカー（最大3個）
  const logs4badge = (data.logs||[]).filter(l=>l.cid===child.id);
  const goodCount  = logs4badge.filter(l=>l.type==="good").length;
  const maxStreak4 = (data.streak||{})[child.id]?.max||0;
  const tipsRead4  = logs4badge.filter(l=>l.type==="tips").length;
  const accessories = [
    goodCount>=100   ? {emoji:"🏆",bg:GOLDS,pos:{top:-6,right:-6}}  : null,
    maxStreak4>=7    ? {emoji:"⚡",bg:BS,   pos:{top:-6,left:-6}}   : null,
    tipsRead4>=10    ? {emoji:"📚",bg:PS,   pos:{bottom:6,left:-6}} : null,
    myBal>=5000      ? {emoji:"💎",bg:BS,   pos:{bottom:6,right:-6}}: null,
  ].filter(Boolean).slice(0,3);

  return (
    <div style={{position:"relative",flexShrink:0,textAlign:"center"}}>
      {/* スパークル */}
      {sparkles.map(sp=>(
        <div key={sp.id} style={{
          position:"absolute",top:"40%",left:"50%",
          transform:`translate(${sp.x}px,${sp.y}px)`,
          fontSize:12,pointerEvents:"none",zIndex:50,
          animation:"smSparkle 0.8s ease-out forwards",
        }}>✨</div>
      ))}

      {/* ふきだし */}
      {speech&&(
        <div style={{
          position:"absolute",bottom:"100%",left:"50%",
          transform:"translateX(-50%)",
          marginBottom:6,
          background:"#fff",
          border:`2px solid ${G}`,
          borderRadius:14,padding:"6px 12px",
          fontSize:12,fontWeight:800,color:TEXT,
          whiteSpace:"nowrap",
          boxShadow:"0 4px 18px rgba(24,35,29,0.18)",
          zIndex:10,
          animation:"smPop .25s cubic-bezier(.34,1.56,.64,1)",
          pointerEvents:"none",
        }}>
          {speech}
          <div style={{
            position:"absolute",top:"100%",left:"50%",
            transform:"translateX(-50%)",
            width:0,height:0,
            borderLeft:"7px solid transparent",borderRight:"7px solid transparent",
            borderTop:`8px solid ${G}`,
          }}/>
        </div>
      )}

      {/* モンスター画像＋アクセサリー（浮遊アニメ） */}
      <div style={{animation:"monFloat 2.5s ease-in-out infinite"}} onClick={handleTap}>
        <div style={{animation:"monBreathe 3.5s ease-in-out infinite",cursor:"pointer",display:"inline-block",userSelect:"none",position:"relative"}}>
          <img
            src={`/assets/monster_${stage}.png`}
            alt={NAMES[stage]}
            style={{width:size,height:size,objectFit:"contain",display:"block"}}
          />
          {accessories.map((acc,i)=>(
            <div key={i} style={{
              position:"absolute",...acc.pos,
              background:acc.bg,
              borderRadius:"50%",
              width:20,height:20,
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:11,
              boxShadow:"0 2px 6px rgba(0,0,0,0.18)",
              border:"1.5px solid rgba(255,255,255,0.9)",
            }}>{acc.emoji}</div>
          ))}
        </div>
      </div>
      {/* 影 */}
      <div style={{width:50,height:8,borderRadius:"50%",background:"rgba(0,0,0,0.15)",margin:"-4px auto 0",animation:"monShadow 2.5s ease-in-out infinite"}}/>

      {/* 名前（Juniorはニックネーム編集可） */}
      {update ? (
        editNick ? (
          <div style={{marginTop:4}}>
            <input value={nickInput} onChange={e=>setNickInput(e.target.value)}
              onBlur={()=>{if(nickInput.trim())update(d=>({...d,monsterNickname:{...(d.monsterNickname||{}),[child.id]:nickInput.trim()}}));setEditNick(false);}}
              onKeyDown={e=>{if(e.key==="Enter"){if(nickInput.trim())update(d=>({...d,monsterNickname:{...(d.monsterNickname||{}),[child.id]:nickInput.trim()}}));setEditNick(false);}if(e.key==="Escape")setEditNick(false);}}
              autoFocus maxLength={8}
              style={{fontSize:12,border:"1.5px solid rgba(255,255,255,0.5)",borderRadius:8,padding:"3px 8px",textAlign:"center",width:80,fontFamily:"inherit",color:"#fff",background:"rgba(255,255,255,0.15)",outline:"none"}}
            />
          </div>
        ) : (
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:3,marginTop:2}}>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.9)",fontWeight:800}}>{(data.monsterNickname||{})[child.id]||NAMES[stage]}{stage===4&&" 👑"}</div>
            <button onClick={()=>{setNickInput((data.monsterNickname||{})[child.id]||NAMES[stage]);setEditNick(true);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:9,color:"rgba(255,255,255,0.45)",padding:0,lineHeight:1}}>✏</button>
          </div>
        )
      ) : (
        <div style={{fontSize:10,color:"rgba(255,255,255,0.88)",fontWeight:800,marginTop:2,letterSpacing:0.3}}>
          {NAMES[stage]}{stage===4&&" 👑"}
        </div>
      )}
      {/* 進化バー */}
      {nextTask&&(
        <div style={{width:90,height:3,background:"rgba(255,255,255,0.18)",borderRadius:999,margin:"3px auto 0",overflow:"hidden"}}>
          <div style={{height:"100%",width:`${evoPct}%`,background:"rgba(255,255,255,0.72)",borderRadius:999,transition:"width 0.6s ease"}}/>
        </div>
      )}
      {!nextTask&&<div style={{fontSize:9,color:"rgba(255,220,0,0.9)",fontWeight:700,marginTop:2}}>MAX✨</div>}

      {/* アニメCSS */}
      <style>{`
        @keyframes smPop{0%{opacity:0;transform:translateX(-50%) scale(0.7)}70%{transform:translateX(-50%) scale(1.06)}100%{opacity:1;transform:translateX(-50%) scale(1)}}
        @keyframes smSparkle{0%{opacity:1;transform:translate(0,0)}100%{opacity:0;transform:translate(0,-28px)}}
        @keyframes monFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
        @keyframes monBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
        @keyframes monShadow{0%,100%{transform:scaleX(1);opacity:.15}50%{transform:scaleX(.55);opacity:.07}}
      `}</style>
    </div>
  );
}

// ── Point Transfer Modal ───────────────────────────────
function PointTransferModal({ child, data, update, onClose }) {
  const [toId,      setToId]      = useState(null);
  const [amount,    setAmount]    = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [done,      setDone]      = useState(false);

  const myBal      = bal(data.logs, child.id);
  const allMembers = [...data.children, ...(data.parents||[])].filter(m => m.id !== child.id);
  const receiver   = allMembers.find(m => m.id === toId);
  const amt        = parseInt(amount);
  const amtOk      = !isNaN(amt) && amt >= 10 && amt <= myBal;

  const doTransfer = () => {
    const now = new Date().toISOString();
    const outE = { id:uid(), cid:child.id,    type:"transfer_out", label:`💸 ${receiver.name}へ送金`,            pts:-amt, toId:receiver.id,  date:now };
    const inE  = { id:uid(), cid:receiver.id, type:"transfer_in",  label:`💌 ${child.name}からのプレゼント！`,   pts: amt, fromId:child.id,   date:now };
    update(d => ({...d, logs:[outE, inE, ...d.logs]}));
    addLogToFirestore(outE);
    addLogToFirestore(inE);
    setDone(true);
  };

  const backdrop = { position:"fixed",inset:0,background:"rgba(0,0,0,0.52)",zIndex:800,display:"flex",alignItems:"flex-end",justifyContent:"center" };
  const sheet    = { background:CARD,borderRadius:"24px 24px 0 0",padding:"28px 22px 36px",width:"100%",maxWidth:480,fontFamily:F,maxHeight:"88vh",overflowY:"auto" };

  if (done) return (
    <div style={backdrop}>
      <div style={{...sheet, textAlign:"center", padding:"40px 24px 48px"}}>
        <div style={{fontSize:64, marginBottom:10}}>🎉</div>
        <div style={{fontWeight:900,fontSize:20,color:GP,marginBottom:6}}>おくったよ！</div>
        <div style={{color:MUTED,fontSize:14,marginBottom:24}}>
          {receiver?.emoji} <strong style={{color:TEXT}}>{receiver?.name}</strong> に{" "}
          <strong style={{color:GP,fontSize:16}}>{amt.toLocaleString()}pt</strong> 届きました
        </div>
        <button onClick={onClose} style={{width:"100%",background:GP,border:"none",borderRadius:14,padding:"14px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>
          とじる
        </button>
      </div>
    </div>
  );

  if (confirmed) return (
    <div style={backdrop}>
      <div style={{...sheet}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <h3 style={{margin:0,fontWeight:900,fontSize:18,color:TEXT}}>これを送りますか？</h3>
          <button onClick={()=>setConfirmed(false)} style={{background:BG,border:"none",borderRadius:10,width:32,height:32,cursor:"pointer",fontSize:16,color:MUTED,fontFamily:F}}>✕</button>
        </div>
        <div style={{background:GS,border:`2px solid ${G}`,borderRadius:18,padding:"20px 16px",marginBottom:20,textAlign:"center"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:18,marginBottom:14}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:30,lineHeight:1}}>{child.emoji}</div>
              <div style={{fontSize:11,fontWeight:700,color:TEXT,marginTop:4}}>{child.name}</div>
              <div style={{fontSize:10,color:R,fontWeight:700}}>-{amt.toLocaleString()}pt</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:26,color:GP}}>→</div>
              <div style={{fontSize:11,color:GP,fontWeight:800}}>{amt.toLocaleString()}pt</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:30,lineHeight:1}}>{receiver?.emoji}</div>
              <div style={{fontSize:11,fontWeight:700,color:TEXT,marginTop:4}}>{receiver?.name}</div>
              <div style={{fontSize:10,color:GP,fontWeight:700}}>+{amt.toLocaleString()}pt</div>
            </div>
          </div>
          <div style={{fontSize:11,color:MUTED}}>送信後の残高: <strong style={{color:GP}}>{(myBal-amt).toLocaleString()}pt</strong></div>
        </div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={()=>setConfirmed(false)} style={{flex:1,background:BORDER,border:"none",borderRadius:14,padding:13,fontWeight:800,color:MUTED,cursor:"pointer",fontFamily:F,fontSize:14}}>
            もどる
          </button>
          <button onClick={doTransfer} style={{flex:2,background:GP,border:"none",borderRadius:14,padding:13,fontWeight:900,color:"#fff",fontSize:15,cursor:"pointer",fontFamily:F}}>
            ✈ 送る！
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={backdrop} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={sheet}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <h3 style={{margin:0,fontWeight:900,fontSize:18,color:TEXT}}>💸 ポイントを送る</h3>
          <button onClick={onClose} style={{background:BG,border:"none",borderRadius:10,width:32,height:32,cursor:"pointer",fontSize:16,color:MUTED,fontFamily:F}}>✕</button>
        </div>
        <div style={{fontSize:12,color:MUTED,marginBottom:16}}>
          💰 いまの残高: <strong style={{color:GP,fontSize:14}}>{myBal.toLocaleString()}pt</strong>
        </div>

        {/* メンバー選択 */}
        <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8,letterSpacing:0.3}}>だれに送る？</div>
        <div style={{marginBottom:16}}>
          {allMembers.map(m => {
            const mBal = bal(data.logs, m.id);
            const sel  = toId === m.id;
            return (
              <button key={m.id} onClick={()=>{setToId(sel?null:m.id);setAmount("");}}
                style={{
                  width:"100%",marginBottom:8,
                  background:sel?`${GP}12`:BG,
                  border:`2px solid ${sel?GP:BORDER}`,
                  borderRadius:14,padding:"11px 14px",
                  display:"flex",alignItems:"center",gap:12,
                  cursor:"pointer",textAlign:"left",fontFamily:F,
                }}>
                <div style={{width:38,height:38,borderRadius:11,background:sel?GP:CARD,border:`1.5px solid ${sel?GP:BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
                  {m.emoji}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,color:TEXT}}>{m.name}</div>
                  <div style={{fontSize:11,color:MUTED}}>{m.gradeLabel||m.displayMode||""} · {mBal.toLocaleString()}pt 所持</div>
                </div>
                <div style={{fontSize:18,color:sel?GP:MUTED,fontWeight:700}}>{sel?"✓":"›"}</div>
              </button>
            );
          })}
        </div>

        {/* 金額入力（相手選択後のみ表示） */}
        {toId && (
          <div>
            <div style={{width:"100%",height:1,background:BORDER,marginBottom:16}}/>
            <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8}}>何pt送る？</div>
            <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
              {[10,50,100,200,500,1000].filter(v=>v<=myBal).map(v=>(
                <button key={v} onClick={()=>setAmount(String(v))}
                  style={{
                    padding:"6px 13px",
                    border:`1.5px solid ${amount===String(v)?GP:BORDER}`,
                    borderRadius:8,
                    background:amount===String(v)?`${GP}18`:"transparent",
                    fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,
                    color:amount===String(v)?GP:MUTED,
                  }}>
                  {v}pt
                </button>
              ))}
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
              <input
                type="number" value={amount} onChange={e=>setAmount(e.target.value)}
                placeholder="pt数を入力（最小10pt）"
                style={{...INP,flex:1,fontSize:15,fontWeight:700}}
              />
              <span style={{fontSize:13,color:MUTED,fontWeight:700,flexShrink:0}}>pt</span>
            </div>
            {!isNaN(amt)&&amt>0&&amt<10&&<div style={{color:R,fontSize:11,fontWeight:700,marginBottom:6}}>最小10ptから送れます</div>}
            {!isNaN(amt)&&amt>myBal&&<div style={{color:R,fontSize:11,fontWeight:700,marginBottom:6}}>残高が足りません</div>}
            <button
              disabled={!amtOk}
              onClick={()=>setConfirmed(true)}
              style={{
                marginTop:8,width:"100%",
                background:amtOk?GP:BORDER,
                border:"none",borderRadius:14,padding:"13px",
                color:amtOk?"#fff":MUTED,
                fontWeight:900,fontSize:15,
                cursor:amtOk?"pointer":"default",
                fontFamily:F,transition:"all 0.2s",
              }}>
              つぎへ →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Weekly Report ─────────────────────────────────────
function WeeklyReport({child,data,onClose}){
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-7);
  const logs=(data.logs||[]).filter(l=>l.cid===child.id&&l.date>=cutoff.toISOString());
  const earned=logs.filter(l=>["good","daily","gacha","interest"].includes(l.type)).reduce((s,l)=>s+l.pts,0);
  const deducted=Math.abs(logs.filter(l=>["bad","violation"].includes(l.type)).reduce((s,l)=>s+l.pts,0));
  const taskCount=logs.filter(l=>l.type==="good").length;
  const gachaCount=logs.filter(l=>l.type==="gacha").length;
  const curBal=bal(data.logs,child.id);
  const interest=data.interestEnabled?Math.floor(curBal*(data.interestRate||0.05)):0;
  return(
    <div style={{position:"fixed",inset:0,background:"#0009",zIndex:990,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}}>
      <div style={{background:CARD,borderRadius:"24px 24px 0 0",padding:"24px 20px 40px",width:"100%",maxWidth:420,boxShadow:"0 -8px 40px #0004"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
          <ChildAvatar child={child} size={40}/>
          <div style={{flex:1}}><div style={{fontWeight:900,fontSize:17,color:TEXT}}>{child.name}の週次レポート</div><div style={{color:MUTED,fontSize:12}}>過去7日間のまとめ</div></div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>✕</button>
        </div>
        <div style={{background:`linear-gradient(135deg,${Y}30,${G}20)`,borderRadius:16,padding:"14px 18px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{color:MUTED,fontSize:12,fontWeight:700}}>現在の残高</div><div style={{fontWeight:900,fontSize:28,color:TEXT}}>{curBal.toLocaleString()}pt</div></div>
          {data.interestEnabled&&interest>0&&<div style={{textAlign:"right"}}><div style={{color:MUTED,fontSize:11,fontWeight:700}}>次回利子（予定）</div><div style={{fontWeight:900,fontSize:18,color:G}}>+{interest}pt</div></div>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
          {[["🏆","お手伝い",`${taskCount}回`,null,"#34c77b"],["🎰","ガチャ",`${gachaCount}回`,null,"#f5c842"],["💰","獲得合計",null,earned,"#34c77b"],["📉","マイナス",null,-deducted,"#f0605a"]].map(([e,l,v,p,c],i)=>(
            <div key={i} style={{background:BG,borderRadius:12,padding:"10px 8px",textAlign:"center"}}>
              <div style={{fontSize:20,marginBottom:4}}>{e}</div>
              <div style={{color:MUTED,fontSize:10,fontWeight:700,marginBottom:2}}>{l}</div>
              {p!==null?<div style={{fontWeight:900,fontSize:14,color:c}}>{p>=0?"+":""}{p}pt</div>:<div style={{fontWeight:900,fontSize:14,color:c}}>{v}</div>}
            </div>
          ))}
        </div>
        <div style={{background:`${G}15`,border:`1.5px solid ${G}40`,borderRadius:14,padding:"12px 14px",marginBottom:16}}>
          <p style={{margin:0,fontSize:13,fontWeight:700,lineHeight:1.7,color:TEXT}}>
            {taskCount>=5?"🌟 すごい！今週はお手伝いをたくさんしたね！":taskCount>=3?"👍 いい調子！来週もがんばろう！":"💪 来週はもっとお手伝いに挑戦してみよう！"}
          </p>
        </div>
        <button onClick={onClose} style={{width:"100%",background:G,border:"none",borderRadius:14,padding:"13px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>とじる</button>
      </div>
    </div>
  );
}

// ── GoalCelebration ───────────────────────────────────
function GoalCelebration({goal,onClose}){
  return(
    <div style={{position:"fixed",inset:0,background:"#000c",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      <div style={{textAlign:"center"}}>
        <div style={{position:"fixed",inset:0,pointerEvents:"none",overflow:"hidden"}}>
          {[...Array(24)].map((_,i)=>(
            <div key={i} style={{position:"absolute",left:`${Math.random()*100}%`,top:`-${Math.random()*20}%`,fontSize:18,animation:`confetti ${1.5+Math.random()}s ${Math.random()*0.8}s linear forwards`}}>
              {["🎊","🎉","⭐","✨","🌟"][i%5]}
            </div>
          ))}
        </div>
        <div style={{background:CARD,borderRadius:28,padding:"40px 44px",boxShadow:`0 20px 80px ${Y}80`,border:`4px solid ${Y}`,position:"relative"}}>
          <div style={{fontSize:64,marginBottom:12}}>{goal.emoji}</div>
          <div style={{color:Y,fontWeight:900,fontSize:20,marginBottom:8}}>目標達成おめでとう！</div>
          <div style={{fontWeight:900,fontSize:22,color:TEXT,marginBottom:8}}>{goal.label}</div>
          <div style={{color:MUTED,fontSize:14,marginBottom:24}}>{goal.target.toLocaleString()}pt 貯まったよ！</div>
          <button onClick={onClose} style={{background:Y,border:"none",borderRadius:14,padding:"14px 40px",color:TEXT,fontWeight:900,fontSize:16,cursor:"pointer",fontFamily:F}}>やったー！🎉</button>
        </div>
      </div>
      <style>{`@keyframes confetti{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}`}</style>
    </div>
  );
}

// ── InvestTab ─────────────────────────────────────────
function StockChart({history, color="#34c77b", height=60, width=300}){
  if(!history||history.length<2) return <div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#aaa",fontSize:11}}>データなし</div>;
  const min=Math.min(...history), max=Math.max(...history), range=max-min||1;
  const pts=history.map((v,i)=>`${Math.round(i/(history.length-1)*width)},${Math.round((1-(v-min)/range)*(height-8)+4)}`).join(" ");
  const fillPts=`0,${height} ${pts} ${width},${height}`;
  return(
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.3"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs>
      <polygon points={fillPts} fill="url(#sg)"/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round"/>
      <circle cx={Math.round((history.length-1)/(history.length-1)*width)} cy={Math.round((1-(history[history.length-1]-min)/range)*(height-8)+4)} r="4" fill={color}/>
    </svg>
  );
}

function ForexSection({data, update, child}){
  const forex = data.forex||{};
  const pairs = Object.values(forex);
  const [selected, setSelected] = useState(null);
  const [tradeMode, setTradeMode] = useState("buy"); // buy | sell
  const [tradeAmt, setTradeAmt] = useState(""); // 外貨の金額
  const myBal = bal(data.logs, child?.id||"");

  const FOREX_BUY_FEE  = 0.02; // 買い手数料2%
  const FOREX_SELL_FEE = 0.02; // 売り手数料2%

  // 保有外貨
  const myForex = (data.forexHoldings||{})[child?.id||""]||{};

  const doForexBuy = (fx) => {
    const amt = parseFloat(tradeAmt);
    if(!amt || amt <= 0 || !child) return;
    const rate = fx.price||0;
    const costPts = Math.ceil(amt * rate * (1 + FOREX_BUY_FEE));
    if(myBal < costPts) { alert("残高が足りないよ！"); return; }
    const entry = {id:uid(),cid:child.id,type:"forex_buy",
      label:`💱 ${fx.flag}${fx.code} ${amt}購入（¥${rate}×${(1+FOREX_BUY_FEE*100).toFixed(0)}%手数料込）`,
      pts:-costPts, date:new Date().toISOString()};
    update(d=>({
      ...d,
      logs:[entry,...d.logs],
      forexHoldings:{...(d.forexHoldings||{}),
        [child.id]:{...(d.forexHoldings?.[child.id]||{}),
          [fx.code]:((d.forexHoldings?.[child.id]?.[fx.code])||0)+amt
        }
      }
    }));
    addLogToFirestore(entry);
    setTradeAmt("");
  };

  const doForexSell = (fx) => {
    const amt = parseFloat(tradeAmt);
    const held = myForex[fx.code]||0;
    if(!amt || amt <= 0 || amt > held || !child) return;
    const rate = fx.price||0;
    const earnPts = Math.floor(amt * rate * (1 - FOREX_SELL_FEE));
    const entry = {id:uid(),cid:child.id,type:"forex_sell",
      label:`💱 ${fx.flag}${fx.code} ${amt}売却（手数料2%引後）`,
      pts:earnPts, date:new Date().toISOString()};
    update(d=>({
      ...d,
      logs:[entry,...d.logs],
      forexHoldings:{...(d.forexHoldings||{}),
        [child.id]:{...(d.forexHoldings?.[child.id]||{}),
          [fx.code]:((d.forexHoldings?.[child.id]?.[fx.code])||0)-amt
        }
      }
    }));
    addLogToFirestore(entry);
    setTradeAmt("");
  };

  if(pairs.length===0) return(
    <div style={{padding:"20px 0",textAlign:"center"}}>
      <p style={{color:MUTED,fontSize:13}}>為替データを読み込み中…</p>
      <button onClick={()=>update(d=>({...d,stockLastUpdate:"",stockFetchStatus:"idle"}))}
        style={{marginTop:8,padding:"8px 20px",background:B,border:"none",borderRadius:10,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
        再読み込み
      </button>
    </div>
  );

  // 外貨保有合計（円・pt換算）
  const totalForexJpy=pairs.reduce((s,fx)=>s+(myForex[fx.code]||0)*(fx.price||0),0);
  const totalForexPts=Math.round(totalForexJpy/100);
  const heldPairs=pairs.filter(fx=>(myForex[fx.code]||0)>0);

  return(
    <div>
      {/* 外貨ポートフォリオカード（常時表示） */}
      <div style={{background:"linear-gradient(135deg,#1a1a2e,#16213e)",borderRadius:20,padding:18,marginBottom:14,color:"#fff"}}>
        <p style={{color:"#aaa",fontSize:12,fontWeight:700,margin:"0 0 4px"}}>💱 外貨ポートフォリオ</p>
        <div style={{fontSize:28,fontWeight:900,marginBottom:4,color:"#f5c842"}}>
          {Math.round(totalForexJpy).toLocaleString()}円
        </div>
        <div style={{display:"flex",gap:16,marginBottom:heldPairs.length>0?10:0}}>
          <div>
            <span style={{color:"#aaa",fontSize:11}}>pt換算 </span>
            <span style={{fontWeight:700,fontSize:13,color:"#4ade80"}}>{totalForexPts.toLocaleString()}pt</span>
          </div>
        </div>
        {heldPairs.length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:"4px 12px",marginBottom:8}}>
            {heldPairs.map(fx=>{
              const h=myForex[fx.code]||0;
              const jpy=Math.round(h*(fx.price||0));
              return(
                <div key={fx.code} style={{display:"flex",alignItems:"center",gap:4,fontSize:11}}>
                  <span>{fx.flag}</span>
                  <span style={{color:"#ccc"}}>{fx.code} {h}</span>
                  <span style={{color:"#f5c842",fontWeight:700}}>¥{jpy.toLocaleString()}</span>
                  <span style={{color:"#4ade80",fontWeight:700}}>{Math.round(jpy/100)}pt</span>
                </div>
              );
            })}
          </div>
        )}
        {heldPairs.length===0&&(
          <div style={{fontSize:11,color:"#555",marginBottom:4}}>保有なし — 下の通貨をタップして購入できます</div>
        )}
        <div style={{marginTop:6,color:"#aaa",fontSize:11}}>💰 残高: <span style={{color:"#fff",fontWeight:700}}>{myBal.toLocaleString()}pt</span></div>
        <div style={{fontSize:10,color:"#444",marginTop:4}}>※ 100円 = 1pt換算・手数料除く</div>
      </div>

      {/* レートヘッダー */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:0,flex:1}}>💱 為替レート（対円）</p>
        <span style={{fontSize:10,color:pairs[0]?.realData?"#4ade80":"#f87171",fontWeight:700}}>
          {pairs[0]?.realData?"● LIVE":"● シミュ"}
        </span>
      </div>

      {pairs.map(fx=>{
        const isUp=(fx.changePct||0)>=0;
        const isSel=selected===fx.code;
        const held = myForex[fx.code]||0;
        const tradeAmtNum = parseFloat(tradeAmt)||0;
        const buyCost = Math.ceil(tradeAmtNum*(fx.price||0)*(1+FOREX_BUY_FEE));
        const sellEarn = Math.floor(tradeAmtNum*(fx.price||0)*(1-FOREX_SELL_FEE));

        return(
          <div key={fx.code} style={{background:isSel?"#1a1a2e":CARD,border:`2px solid ${isSel?"#4a9eff":BORDER}`,borderRadius:16,padding:"12px 14px",marginBottom:10,transition:"all .2s"}}>
            {/* ヘッダー行 */}
            <button onClick={()=>setSelected(isSel?null:fx.code)}
              style={{width:"100%",background:"none",border:"none",cursor:"pointer",textAlign:"left",fontFamily:F,padding:0}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:28,flexShrink:0}}>{fx.flag}</span>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:13,color:isSel?"#fff":TEXT}}>{fx.name}</div>
                  <div style={{color:isSel?"#aaa":MUTED,fontSize:11}}>
                    1 {fx.code} ={" "}
                    <span style={{fontWeight:900,fontSize:15,color:isSel?"#fff":TEXT}}>
                      ¥{(fx.price||0).toFixed(fx.code==="KRW"?3:2)}
                    </span>
                  </div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:13,fontWeight:700,color:isUp?"#4ade80":"#f87171"}}>
                    {isUp?"▲":"▼"}{Math.abs(fx.changePct||0).toFixed(2)}%
                  </div>
                  {held>0?(
                    <>
                      <div style={{fontSize:10,color:"#f5c842",fontWeight:700}}>保有:{held}{fx.code}</div>
                      <div style={{fontSize:10,color:"#4ade80",fontWeight:700}}>≈¥{Math.round(held*(fx.price||0)).toLocaleString()} / {Math.round(held*(fx.price||0)/100)}pt</div>
                    </>
                  ):(
                    <div style={{fontSize:10,color:"#555",fontWeight:700}}>未保有</div>
                  )}
                </div>
              </div>
            </button>

            {/* グラフ（常時表示） */}
            {fx.history&&fx.history.length>1&&(
              <div style={{marginTop:8}}>
                <StockChart history={fx.history} color={isUp?"#4ade80":"#f87171"} height={45} width={300}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#888",marginTop:2}}>
                  <span>30日前: ¥{(fx.history[0]||0).toFixed(fx.code==="KRW"?3:2)}</span>
                  <span>現在: ¥{(fx.price||0).toFixed(fx.code==="KRW"?3:2)}</span>
                </div>
              </div>
            )}

            {/* 展開時：売買パネル */}
            {isSel&&child&&(
              <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #333"}}>
                {/* 換算例 */}
                {(()=>{const ex=fx.code==="KRW"?10000:100;const exJpy=Math.round(ex*(fx.price||0));const exPts=Math.round(exJpy/100);return(
                <div style={{background:"#0d0d1a",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#aaa",marginBottom:10}}>
                  <div>💡 <span style={{color:"#fff",fontWeight:700}}>{ex}{fx.code}</span> を円に換えると <span style={{color:"#f5c842",fontWeight:700}}>¥{exJpy.toLocaleString()}</span></div>
                  <div style={{marginTop:2}}>　 ポイントに換えると <span style={{color:"#4ade80",fontWeight:700}}>{exPts}pt</span>（100円=1pt）</div>
                </div>);})()}

                {/* 買い/売り切替 */}
                <div style={{display:"flex",gap:6,marginBottom:10}}>
                  {["buy","sell"].map(m=>(
                    <button key={m} onClick={()=>{setTradeMode(m);setTradeAmt("");}}
                      style={{flex:1,padding:"7px 0",border:"none",borderRadius:8,
                        background:tradeMode===m?(m==="buy"?"#22c55e":"#ef4444"):"#1e2030",
                        color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
                      {m==="buy"?"💰 買う":"💸 売る"}
                    </button>
                  ))}
                </div>

                {/* 金額入力 */}
                <div style={{display:"flex",gap:6,marginBottom:8}}>
                  <input value={tradeAmt} onChange={e=>setTradeAmt(e.target.value)}
                    type="number" placeholder={`${fx.code}の数量`}
                    style={{flex:1,padding:"9px 12px",background:"#0d0d1a",border:"1px solid #333",
                      borderRadius:8,color:"#fff",fontSize:14,fontFamily:F}}/>
                  <button onClick={()=>tradeMode==="buy"?doForexBuy(fx):doForexSell(fx)}
                    disabled={tradeMode==="sell"&&tradeAmtNum>held}
                    style={{padding:"9px 16px",background:tradeMode==="buy"?"#22c55e":"#ef4444",
                      border:"none",borderRadius:8,color:"#fff",fontWeight:700,fontSize:13,
                      cursor:"pointer",fontFamily:F,opacity:tradeMode==="sell"&&tradeAmtNum>held?0.4:1}}>
                    {tradeMode==="buy"?"買う":"売る"}
                  </button>
                </div>

                {/* コスト表示 */}
                {tradeAmtNum>0&&(
                  <div style={{background:"#0d0d1a",borderRadius:8,padding:"8px 10px",fontSize:11}}>
                    {tradeMode==="buy"?<>
                      <div style={{display:"flex",justifyContent:"space-between",color:"#aaa",marginBottom:2}}>
                        <span>レート</span><span>{tradeAmtNum}{fx.code} × ¥{(fx.price||0).toFixed(2)}</span>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",color:"#f5c842",marginBottom:2}}>
                        <span>手数料(2%)</span><span>+{(buyCost-Math.round(tradeAmtNum*(fx.price||0))).toLocaleString()}pt</span>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",color:"#fff",fontWeight:700}}>
                        <span>合計</span><span>{buyCost.toLocaleString()}pt</span>
                      </div>
                      {myBal<buyCost&&<p style={{color:"#f87171",margin:"4px 0 0",fontWeight:700}}>残高不足</p>}
                    </>:<>
                      <div style={{display:"flex",justifyContent:"space-between",color:"#aaa",marginBottom:2}}>
                        <span>保有</span><span>{held}{fx.code}</span>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",color:"#f5c842",marginBottom:2}}>
                        <span>手数料(2%)</span><span>-{(Math.round(tradeAmtNum*(fx.price||0))-sellEarn).toLocaleString()}pt</span>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",color:"#fff",fontWeight:700}}>
                        <span>受取</span><span>{sellEarn.toLocaleString()}pt</span>
                      </div>
                      {tradeAmtNum>held&&<p style={{color:"#f87171",margin:"4px 0 0",fontWeight:700}}>保有量が足りない（{held}{fx.code}）</p>}
                    </>}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


function InvestTab({child,data,update}){
  const [investTab,setInvestTab]=useState("stocks"); // stocks | forex
  const [selected,setSelected]=useState(null);
  const [mode,setMode]=useState("buy");
  const [qty,setQty]=useState("0.1");
  const [tradeComment,setTradeComment]=useState("");
  const [showChart,setShowChart]=useState(null);
  const [showShare,setShowShare]=useState(false);
  const [shareCopied,setShareCopied]=useState(false);
  const myBal=bal(data.logs,child.id);
  const myHoldings=(data.holdings||{})[child.id]||[];
  const stocks=data.stocks||[];
  const fetchStatus=data.stockFetchStatus||"idle";
  const fmtPrice=s=>s.currency==="USD"?`$${s.price.toFixed(2)}`:`¥${Math.round(s.price).toLocaleString()}`;
  const toPts=(s,p)=>s.currency==="USD"?Math.max(1,Math.round(p*1.5)):Math.max(1,Math.round(p/100));
  const portfolioVal=myHoldings.reduce((s,h)=>{const st=stocks.find(x=>x.id===h.stockId);return s+(st?toPts(st,st.price)*h.qty:0);},0);
  const portfolioCost=myHoldings.reduce((s,h)=>s+h.avgPrice*h.qty,0);
  const portfolioGain=portfolioVal-portfolioCost;
  const selStock=stocks.find(s=>s.id===selected);
  const selHolding=myHoldings.find(h=>h.stockId===selected);
  const qtyN=Math.max(0.1,Math.round((parseFloat(qty)||0.1)*10)/10);
  const basePrice=selStock?Math.round(toPts(selStock,selStock.price)*qtyN):0;
  const FEE_RATE = 0.10; // 10%手数料
  const costPts = Math.ceil(basePrice*(1+FEE_RATE)); // 購入時：価格+10%手数料
  const sellPts = selStock&&selHolding?Math.floor(toPts(selStock,selStock.price)*qtyN*(1-FEE_RATE)):0; // 売却時：価格-10%手数料

  const fmtQty=q=>(q%1===0)?`${q}`:`${q.toFixed(1)}`;
  function doBuy(){
    if(!selStock||qtyN<0.1||myBal<costPts) return;
    update(d=>{
      const existH=(d.holdings?.[child.id]||[]).find(h=>h.stockId===selStock.id);
      let newH;
      const tq=Math.round(((existH?.qty||0)+qtyN)*10)/10;
      if(existH){newH=(d.holdings[child.id]).map(h=>h.stockId===selStock.id?{...h,qty:tq,avgPrice:Math.round((existH.avgPrice*existH.qty+costPts)/tq)}:h);}
      else newH=[...(d.holdings?.[child.id]||[]),{stockId:selStock.id,qty:qtyN,avgPrice:Math.round(costPts/qtyN),firstBuyDate:new Date().toISOString()}];
      const commentPart=tradeComment?` ・ ${tradeComment}`:"";
      return{...d,holdings:{...(d.holdings||{}),[child.id]:newH},logs:(()=>{const _e={id:uid(),cid:child.id,type:"invest_buy",label:`📈 ${selStock.emoji}${selStock.name} ${fmtQty(qtyN)}株 購入${commentPart}`,pts:-costPts,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})()};
    });
    setQty("0.1");setSelected(null);setTradeComment("");
  }
  function doSell(){
    if(!selStock||!selHolding||qtyN<0.1||qtyN>selHolding.qty) return;
    update(d=>({...d,holdings:{...(d.holdings||{}),[child.id]:(d.holdings[child.id]).map(h=>h.stockId===selStock.id?{...h,qty:Math.round((h.qty-qtyN)*10)/10}:h).filter(h=>h.qty>0)},logs:(()=>{const _e={id:uid(),cid:child.id,type:"invest_sell",label:`📉 ${selStock.emoji}${selStock.name} ${fmtQty(qtyN)}株 売却（手数料10%引後）`,pts:sellPts,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})()}));
    setQty("0.1");setSelected(null);
  }

  return(<div style={{padding:"12px 16px",paddingBottom:32}}>
    {/* ポートフォリオ シェアモーダル */}
    {showShare&&(
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:900,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setShowShare(false)}>
        <div style={{background:"linear-gradient(160deg,#060d1a,#0f1a2e)",borderRadius:24,padding:24,maxWidth:340,width:"100%",color:"#fff",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}} onClick={e=>e.stopPropagation()}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
            <div style={{fontSize:11,color:"#4a9eff",fontWeight:800,letterSpacing:2}}>TANE MONEY</div>
            <button onClick={()=>setShowShare(false)} style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:8,width:28,height:28,cursor:"pointer",color:"rgba(255,255,255,0.6)",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>✕</button>
          </div>
          <div style={{marginBottom:16}}>
            <div style={{color:"rgba(255,255,255,0.4)",fontSize:11,marginBottom:6}}>{child.emoji} {child.name} の投資ポートフォリオ</div>
            <div style={{display:"flex",alignItems:"flex-end",gap:6,marginBottom:4}}>
              <span style={{fontSize:34,fontWeight:900,lineHeight:1}}>{portfolioVal.toLocaleString()}</span>
              <span style={{fontSize:13,color:"#4a9eff",fontWeight:700,marginBottom:4}}>pt</span>
            </div>
            <div style={{display:"flex",gap:16}}>
              <span style={{color:"rgba(255,255,255,0.4)",fontSize:11}}>投資額 <strong style={{color:"#fff"}}>{portfolioCost.toLocaleString()}pt</strong></span>
              <span style={{fontSize:11,fontWeight:800,color:portfolioGain>=0?"#4ade80":"#f87171"}}>{portfolioGain>=0?"▲":"▼"} {Math.abs(portfolioGain).toLocaleString()}pt ({portfolioCost>0?(Math.abs(portfolioGain/portfolioCost)*100).toFixed(1):0}%)</span>
            </div>
          </div>
          <div style={{height:1,background:"rgba(255,255,255,0.07)",margin:"0 0 16px"}}/>
          {myHoldings.length>0?(
            <div style={{marginBottom:16}}>
              <div style={{color:"rgba(255,255,255,0.3)",fontSize:9,fontWeight:700,letterSpacing:1,marginBottom:10}}>HOLDINGS</div>
              {myHoldings.map(h=>{
                const st=stocks.find(x=>x.id===h.stockId);if(!st)return null;
                const val=toPts(st,st.price)*h.qty;
                const pct=portfolioVal>0?Math.round(val/portfolioVal*100):0;
                const gain=val-h.avgPrice*h.qty;
                const fq=h.qty%1===0?`${h.qty}`:`${h.qty.toFixed(1)}`;
                return(
                  <div key={h.stockId} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <span style={{fontSize:22}}>{st.emoji}</span>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13}}>{st.name}</div>
                      <div style={{color:"rgba(255,255,255,0.35)",fontSize:10}}>{fq}株 · {pct}%</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontWeight:700,fontSize:12}}>{val.toLocaleString()}pt</div>
                      <div style={{fontSize:11,color:gain>=0?"#4ade80":"#f87171",fontWeight:700}}>{gain>=0?"+":""}{gain.toLocaleString()}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ):(
            <div style={{background:"rgba(74,158,255,0.06)",border:"1px solid rgba(74,158,255,0.12)",borderRadius:12,padding:"14px 16px",marginBottom:16}}>
              <div style={{color:"rgba(255,255,255,0.5)",fontSize:12,fontWeight:700,marginBottom:6}}>📈 株ってなに？</div>
              <div style={{color:"rgba(255,255,255,0.3)",fontSize:11,lineHeight:1.6}}>会社の一部を買うこと。価格が上がれば利益が出て、下がれば損になる。下のリストから気になる株をタップして買ってみよう。</div>
            </div>
          )}
          {(()=>{const bc=(data.logs||[]).filter(l=>l.cid===child.id&&l.type==="badge").length;return bc>0&&(
            <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:12,padding:"8px 14px",display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <span style={{fontSize:18}}>🏅</span>
              <span style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>バッジ <strong style={{color:"#fbbf24"}}>{bc}個</strong> 獲得済み</span>
            </div>
          );})()}
          <button onClick={async()=>{
            const gainStr=portfolioGain>=0?`+${portfolioGain.toLocaleString()}`:portfolioGain.toLocaleString();
            const txt=`${child.emoji} ${child.name}のポートフォリオ\n💰 ${portfolioVal.toLocaleString()}pt（損益: ${gainStr}pt）\n${myHoldings.map(h=>{const st=stocks.find(x=>x.id===h.stockId);return st?`${st.emoji}${st.name}`:""}).filter(Boolean).join("・")}\n🌱 tane-money.vercel.app`;
            if(navigator.share){try{await navigator.share({title:"TANE MONEY ポートフォリオ",text:txt});}catch(e){}}
            else{navigator.clipboard?.writeText(txt);setShareCopied(true);setTimeout(()=>setShareCopied(false),2500);}
          }} style={{width:"100%",background:shareCopied?"rgba(74,222,128,0.15)":"#4a9eff",border:shareCopied?"1px solid #4ade80":"none",borderRadius:14,padding:"12px",color:shareCopied?"#4ade80":"#fff",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:F,marginTop:8,transition:"all .3s"}}>
            {shareCopied?"✓ コピーしました！":"📤 LINEで送る / シェア"}
          </button>
          <div style={{textAlign:"center",color:"rgba(255,255,255,0.12)",fontSize:9,letterSpacing:0.5,marginTop:8}}>🌱 tane-money.vercel.app</div>
        </div>
      </div>
    )}
    {/* タブ切替：株 / 為替 */}
    <div style={{display:"flex",gap:0,background:"#1a1a2e",borderRadius:14,overflow:"hidden",marginBottom:14}}>
      {[["stocks","📈 株"],["forex","💱 為替"]].map(([v,l])=>(
        <button key={v} onClick={()=>setInvestTab(v)}
          style={{flex:1,padding:"10px 0",border:"none",background:investTab===v?"#4a9eff":"transparent",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>
          {l}
        </button>
      ))}
    </div>

    {investTab==="forex"&&<ForexSection data={data} update={update} child={child}/>}

    {investTab==="stocks"&&<>
      {/* ステータスバー */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <div style={{flex:1,fontSize:11,color:fetchStatus==="ok"?"#4ade80":fetchStatus==="error"?"#f87171":MUTED,fontWeight:700}}>
          {fetchStatus==="loading"&&"📡 取得中…"}
          {fetchStatus==="ok"&&`✅ LIVE · ${data.stockLastUpdate}`}
          {fetchStatus==="error"&&"⚠ シミュレーション値"}
          {(fetchStatus==="idle"||!fetchStatus)&&"読み込み中…"}
        </div>
        <button onClick={()=>update(d=>({...d,stockLastUpdate:"",stockFetchStatus:"idle"}))}
          style={{background:"#ffffff20",border:`1px solid ${BORDER}`,borderRadius:8,padding:"3px 9px",color:MUTED,fontSize:11,cursor:"pointer",fontFamily:F}}>更新</button>
      </div>

      {/* ポートフォリオ */}
      <div style={{background:"linear-gradient(135deg,#1a1a2e,#16213e)",borderRadius:20,padding:18,marginBottom:14,color:"#fff"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
          <p style={{color:"#aaa",fontSize:12,fontWeight:700,margin:0}}>📊 ポートフォリオ</p>
          <button onClick={()=>setShowShare(true)} style={{background:"rgba(74,158,255,0.15)",border:"1px solid rgba(74,158,255,0.3)",borderRadius:8,padding:"3px 10px",color:"#4a9eff",fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:F}}>📸 シェア</button>
        </div>
        <div style={{fontSize:28,fontWeight:900,marginBottom:4}}>{portfolioVal.toLocaleString()}pt</div>
        <div style={{display:"flex",gap:16,marginBottom:myHoldings.length>0?12:0}}>
          <div><span style={{color:"#aaa",fontSize:11}}>投資額 </span><span style={{fontWeight:700,fontSize:13}}>{portfolioCost.toLocaleString()}pt</span></div>
          <div><span style={{color:"#aaa",fontSize:11}}>損益 </span><span style={{fontWeight:700,fontSize:13,color:portfolioGain>=0?"#4ade80":"#f87171"}}>{portfolioGain>=0?"+":""}{portfolioGain.toLocaleString()}pt</span></div>
        </div>
        {myHoldings.length>0&&(()=>{
          const total=portfolioVal||1;
          const colors={"7974.T":"#e4002b","6758.T":"#003087","7203.T":"#eb0a1e","MCD":"#ffc72c","AAPL":"#999"};
          return(<>
            <div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",gap:1,marginBottom:6}}>
              {myHoldings.map(h=>{const st=stocks.find(x=>x.id===h.stockId);if(!st)return null;const pct=toPts(st,st.price)*h.qty/total*100;return<div key={h.stockId} style={{width:`${pct}%`,background:colors[st.ticker]||"#4a9eff",minWidth:3}}/>;  })}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:"2px 10px"}}>
              {myHoldings.map(h=>{const st=stocks.find(x=>x.id===h.stockId);if(!st)return null;const pct=Math.round(toPts(st,st.price)*h.qty/total*100);const fq=h.qty%1===0?`${h.qty}`:`${h.qty.toFixed(1)}`;return(<div key={h.stockId} style={{display:"flex",alignItems:"center",gap:4,fontSize:10}}><div style={{width:8,height:8,borderRadius:2,background:colors[st.ticker]||"#4a9eff"}}/><span style={{color:"#ccc"}}>{st.emoji}{st.name} {fq}株 {pct}%</span></div>);})}
            </div>
          </>);
        })()}
        <div style={{marginTop:8,color:"#aaa",fontSize:11}}>💰 残高: <span style={{color:"#fff",fontWeight:700}}>{myBal.toLocaleString()}pt</span></div>
      </div>

      {/* 銘柄一覧 */}
      <p style={{color:MUTED,fontSize:12,fontWeight:700,marginBottom:10}}>📈 銘柄一覧（前日終値・毎日更新）</p>
      {stocks.map(s=>{
        const h=myHoldings.find(x=>x.stockId===s.id);
        const isUp=(s.lastChange||0)>=0;
        const isSel=selected===s.id;
        const showC=showChart===s.id;
        return(<div key={s.id} style={{marginBottom:10}}>
          <button onClick={()=>{setSelected(isSel?null:s.id);setMode("buy");setQty("0.1");setTradeComment("");}}
            style={{width:"100%",background:isSel?"#1a1a2e":CARD,border:`2px solid ${isSel?"#4a9eff":BORDER}`,borderRadius:18,padding:"12px 14px",cursor:"pointer",textAlign:"left",fontFamily:F,transition:"all .2s"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:26}}>{s.emoji}</span>
              <div style={{flex:1}}>
                <div style={{fontWeight:800,fontSize:14,color:isSel?"#fff":TEXT}}>{s.name}</div>
                <div style={{color:isSel?"#aaa":MUTED,fontSize:11}}>{s.sector}</div>
                {s.lastComment&&<div style={{color:isSel?"#888":MUTED,fontSize:10,marginTop:1}}>💬 {s.lastComment}</div>}
              </div>
              <div style={{textAlign:"right",minWidth:80}}>
                {/* ミニスパークライン */}
                {s.history&&s.history.length>1&&(
                  <svg width={60} height={24} viewBox="0 0 60 24" preserveAspectRatio="none" style={{display:"block",marginLeft:"auto",marginBottom:2}}>
                    {(()=>{
                      const h2=s.history;
                      const mn=Math.min(...h2),mx=Math.max(...h2),r=mx-mn||1;
                      const pts=h2.map((v,i)=>`${Math.round(i/(h2.length-1)*60)},${Math.round((1-(v-mn)/r)*20+2)}`).join(" ");
                      return<polyline points={pts} fill="none" stroke={isUp?"#4ade80":"#f87171"} strokeWidth={2}/>;
                    })()}
                  </svg>
                )}
                <div style={{fontWeight:900,fontSize:14,color:isSel?"#fff":TEXT}}>{fmtPrice(s)}</div>
                <div style={{fontSize:10,color:"#aaa"}}>{toPts(s,s.price).toLocaleString()}pt/株</div>
                <div style={{fontSize:12,fontWeight:700,color:isUp?"#4ade80":"#f87171"}}>{isUp?"▲":"▼"}{Math.abs(s.lastChange||0).toFixed(1)}%</div>
                {s.realData&&<div style={{fontSize:9,color:"#4ade80",fontWeight:700}}>● LIVE</div>}
              </div>
            </div>
            {h&&<div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${isSel?"#333":BORDER}`,display:"flex",gap:12,fontSize:11}}>
              <span style={{color:isSel?"#aaa":MUTED}}>保有: <span style={{fontWeight:700,color:isSel?"#fff":TEXT}}>{h.qty}株</span></span>
              <span style={{color:isSel?"#aaa":MUTED}}>取得単価: <span style={{fontWeight:700,color:isSel?"#fff":TEXT}}>{h.avgPrice}pt</span></span>
              <span style={{color:(toPts(s,s.price)-h.avgPrice)>=0?"#4ade80":"#f87171",fontWeight:700}}>{(toPts(s,s.price)-h.avgPrice)>=0?"+":""}{((toPts(s,s.price)-h.avgPrice)/h.avgPrice*100).toFixed(1)}%</span>
            </div>}
          </button>

          {/* 詳細チャート（銘柄ごと） */}
          {!isSel&&s.history&&s.history.length>1&&(
            <button onClick={()=>setShowChart(showC?null:s.id)}
              style={{width:"100%",background:showC?"#0d0d1a":"transparent",border:"none",padding:"2px 0 4px",cursor:"pointer",fontFamily:F}}>
              {showC?(
                <div style={{background:"#0d0d1a",borderRadius:14,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{color:"#aaa",fontSize:11,fontWeight:700}}>30日チャート</span>
                    <span style={{color:isUp?"#4ade80":"#f87171",fontSize:12,fontWeight:700}}>{fmtPrice(s)}</span>
                  </div>
                  <StockChart history={s.history} color={isUp?"#4ade80":"#f87171"} height={70} width={300}/>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:10,color:"#666"}}>
                    <span>30日前: {s.currency==="JPY"?`¥${s.history[0]?.toLocaleString()}`:`$${s.history[0]?.toFixed(2)}`}</span>
                    <span>高値: {s.currency==="JPY"?`¥${Math.max(...s.history).toLocaleString()}`:`$${Math.max(...s.history).toFixed(2)}`}</span>
                    <span>安値: {s.currency==="JPY"?`¥${Math.min(...s.history).toLocaleString()}`:`$${Math.min(...s.history).toFixed(2)}`}</span>
                  </div>
                </div>
              ):<span style={{color:"#555",fontSize:10}}>▼ チャートを見る</span>}
            </button>
          )}

          {/* 売買パネル */}
          {isSel&&selStock&&<div style={{background:"#1a1a2e",borderRadius:18,padding:16,border:"2px solid #4a9eff",marginTop:-2}}>
            {/* チャート */}
            {selStock.history&&selStock.history.length>1&&(
              <div style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:11,color:"#aaa"}}>
                  <span>30日チャート</span>
                  <span style={{color:isUp?"#4ade80":"#f87171"}}>{isUp?"▲":"▼"}{Math.abs(selStock.lastChange||0).toFixed(1)}%</span>
                </div>
                <StockChart history={selStock.history} color={isUp?"#4ade80":"#f87171"} height={60} width={300}/>
              </div>
            )}
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <span style={{fontSize:22}}>{selStock.emoji}</span>
              <div style={{flex:1}}><div style={{fontWeight:900,fontSize:14,color:"#fff"}}>{selStock.name}</div><div style={{color:"#aaa",fontSize:11}}>{fmtPrice(selStock)} = {toPts(selStock,selStock.price).toLocaleString()}pt/株</div></div>
              <button onClick={()=>setSelected(null)} style={{background:"none",border:"none",color:"#aaa",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{display:"flex",gap:0,background:"#0d0d1a",borderRadius:10,overflow:"hidden",marginBottom:12}}>
              {["buy","sell"].map(m=><button key={m} onClick={()=>{setMode(m);setQty("0.1");setTradeComment("");}} style={{flex:1,padding:"9px 0",border:"none",background:mode===m?(m==="buy"?"#22c55e":"#ef4444"):"transparent",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>{m==="buy"?"買う":"売る"}</button>)}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <button onClick={()=>setQty(q=>String(Math.max(0.1,Math.round((parseFloat(q||0.1)-0.1)*10)/10)))} style={{width:40,height:40,borderRadius:"50%",border:"1px solid #333",background:"#0d0d1a",color:"#fff",fontSize:20,cursor:"pointer"}}>−</button>
              <input value={qty} onChange={e=>setQty(e.target.value.replace(/[^0-9.]/g,""))} type="number" min="0.1" step="0.1" style={{flex:1,textAlign:"center",fontSize:22,fontWeight:900,background:"#0d0d1a",border:"1px solid #333",borderRadius:10,padding:"7px 0",color:"#fff",fontFamily:F}}/>
              <button onClick={()=>setQty(q=>String(Math.round((parseFloat(q||0.1)+0.1)*10)/10))} style={{width:40,height:40,borderRadius:"50%",border:"none",background:"#4a9eff",color:"#fff",fontSize:20,cursor:"pointer"}}>+</button>
            </div>
            <div style={{display:"flex",gap:6,marginBottom:12}}>
              {[0.1,0.5,1,3].map(v=><button key={v} onClick={()=>setQty(String(v))} style={{flex:1,padding:"6px 0",border:`1px solid ${qtyN===v?"#4a9eff":"#333"}`,borderRadius:8,background:qtyN===v?"#4a9eff20":"transparent",color:qtyN===v?"#4a9eff":"#aaa",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>{fmtQty(v)}株</button>)}
            </div>
            <div style={{background:"#0d0d1a",borderRadius:10,padding:"10px 12px",marginBottom:12}}>
              {mode==="buy"?<>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#aaa",marginBottom:2}}><span>株価</span><span style={{color:"#fff"}}>{basePrice.toLocaleString()}pt</span></div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#f5c842",marginBottom:4}}><span>手数料(10%)</span><span>{(costPts-basePrice).toLocaleString()}pt</span></div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#aaa",marginBottom:4}}><span>合計</span><span style={{color:"#fff",fontWeight:700}}>{costPts.toLocaleString()}pt</span></div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#aaa"}}><span>残高</span><span style={{color:myBal>=costPts?"#4ade80":"#f87171",fontWeight:700}}>{myBal.toLocaleString()}pt</span></div>
                {myBal<costPts&&<p style={{color:"#f87171",fontSize:11,margin:"6px 0 0",fontWeight:700}}>残高が足りないよ</p>}
                <div style={{marginTop:8,fontSize:11,color:"#aaa",marginBottom:4}}>💬 なぜ買う？（任意）</div>
                <input value={tradeComment} onChange={e=>setTradeComment(e.target.value.slice(0,30))} placeholder="例：任天堂好きだから" maxLength={30} style={{width:"100%",background:"#0d0d1a",border:"1px solid #333",borderRadius:8,padding:"7px 10px",color:"#fff",fontSize:13,fontFamily:F,boxSizing:"border-box"}}/>
              </>:<>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#aaa",marginBottom:2}}><span>売却額</span><span style={{color:"#fff"}}>{Math.floor(toPts(selStock||{price:0},selStock?.price||0)*qtyN).toLocaleString()}pt</span></div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#f5c842",marginBottom:4}}><span>手数料(10%)</span><span>-{(Math.floor(toPts(selStock||{price:0},selStock?.price||0)*qtyN)-sellPts).toLocaleString()}pt</span></div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#aaa",marginBottom:4}}><span>受取金額</span><span style={{color:"#fff",fontWeight:700}}>{sellPts.toLocaleString()}pt</span></div>
                {selHolding&&<div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#aaa"}}><span>損益</span><span style={{color:(sellPts-selHolding.avgPrice*qtyN)>=0?"#4ade80":"#f87171",fontWeight:700}}>{(sellPts-selHolding.avgPrice*qtyN)>=0?"+":""}{(sellPts-selHolding.avgPrice*qtyN).toLocaleString()}pt</span></div>}
                {(!selHolding||qtyN>selHolding.qty)&&<p style={{color:"#f87171",fontSize:11,margin:"6px 0 0",fontWeight:700}}>保有株数が足りない（{selHolding?.qty||0}株）</p>}
              </>}
            </div>
            <button onClick={mode==="buy"?doBuy:doSell}
              disabled={mode==="buy"?(myBal<costPts||qtyN<0.1):(!selHolding||qtyN>selHolding.qty||qtyN<0.1)}
              style={{width:"100%",background:mode==="buy"?"#22c55e":"#ef4444",border:"none",borderRadius:12,padding:"13px",color:"#fff",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:F,opacity:(mode==="buy"?(myBal<costPts||qtyN<0.1):(!selHolding||qtyN>selHolding.qty||qtyN<0.1))?0.4:1}}>
              {mode==="buy"?`${fmtQty(qtyN)}株 買う！（${costPts.toLocaleString()}pt）`:`${fmtQty(qtyN)}株 売る！（${sellPts.toLocaleString()}pt受取）`}
            </button>
          </div>}
        </div>);
      })}
    </>}
  </div>);
}


function calcBadgeStats(child, data){
  const logs=(data.logs||[]).filter(l=>l.cid===child.id);
  let run=0, maxBal=0;
  [...logs].reverse().forEach(l=>{run+=l.pts;if(run>maxBal)maxBal=run;});
  return{
    taskCount: logs.filter(l=>["good","bad"].includes(l.type)).length,
    goodCount: logs.filter(l=>l.type==="good").length,
    gachaCount: logs.filter(l=>l.type==="gacha").length,
    rewardCount: logs.filter(l=>l.type==="reward").length,
    investBuy: logs.filter(l=>l.type==="invest_buy").length,
    investSell: logs.filter(l=>l.type==="invest_sell").length,
    interestCount: logs.filter(l=>l.type==="interest").length,
    tipsRead: logs.filter(l=>l.type==="tips").length,
    goalsDone: (data.goals||[]).filter(g=>g.cid===child.id&&g.done).length,
    maxStreak: (data.streak||{})[child.id]?.max||0,
    curStreak: (data.streak||{})[child.id]?.cur||0,
    maxBal,
    totalLogs: logs.length,
    balance: bal(data.logs, child.id),
    perfectDays: Object.values((data.dailyProgress||{})[child.id]||{}).filter(day=>{
      const tasks=(data.dailyTaskSets||[]).find(s=>s.id===data.activeSetId)?.tasks||data.dailyTasks||[];
      return tasks.length>0&&tasks.every(t=>t.type==="check"?!!day[t.id]:(day[t.id]||0)>=(t.target||1));
    }).length,
  };
}

const ALL_BADGES = [
  // 達成系
  {id:"b01",emoji:"🌱",name:"はじめての一歩",desc:"初めてお手伝いをした",type:"achieve",check:s=>s.goodCount>=1},
  {id:"b02",emoji:"🌿",name:"お手伝いビギナー",desc:"お手伝いを10回した",type:"achieve",check:s=>s.goodCount>=10},
  {id:"b03",emoji:"🌳",name:"お手伝いマスター",desc:"お手伝いを50回した",type:"achieve",check:s=>s.goodCount>=50},
  {id:"b04",emoji:"🏆",name:"お手伝いレジェンド",desc:"お手伝いを100回した",type:"achieve",check:s=>s.goodCount>=100},
  {id:"b05",emoji:"💰",name:"初めての100pt",desc:"残高100ptを達成した",type:"achieve",check:s=>s.maxBal>=100},
  {id:"b06",emoji:"💎",name:"1000ptクラブ",desc:"残高1000ptを達成した",type:"achieve",check:s=>s.maxBal>=1000},
  {id:"b07",emoji:"👑",name:"5000ptキング",desc:"残高5000ptを達成した",type:"achieve",check:s=>s.maxBal>=5000},
  {id:"b08",emoji:"🎯",name:"目標達成者",desc:"目標貯金を達成した",type:"achieve",check:s=>s.goalsDone>=1},
  {id:"b09",emoji:"🎊",name:"目標達成マスター",desc:"目標貯金を3回達成した",type:"achieve",check:s=>s.goalsDone>=3},
  // 行動系
  {id:"b10",emoji:"🎰",name:"ガチャデビュー",desc:"初めてガチャを引いた",type:"action",check:s=>s.gachaCount>=1},
  {id:"b11",emoji:"🎲",name:"ガチャ中毒",desc:"ガチャを30回引いた",type:"action",check:s=>s.gachaCount>=30},
  {id:"b12",emoji:"🛍",name:"こうかんデビュー",desc:"初めてこうかんした",type:"action",check:s=>s.rewardCount>=1},
  {id:"b13",emoji:"🛒",name:"こうかん上手",desc:"こうかんを10回した",type:"action",check:s=>s.rewardCount>=10},
  {id:"b14",emoji:"📈",name:"投資デビュー",desc:"初めて株を買った",type:"action",check:s=>s.investBuy>=1},
  {id:"b15",emoji:"📊",name:"投資家",desc:"株を売買5回した",type:"action",check:s=>s.investBuy+s.investSell>=5},
  {id:"b16",emoji:"💹",name:"投資マスター",desc:"株を売買20回した",type:"action",check:s=>s.investBuy+s.investSell>=20},
  {id:"b17",emoji:"💸",name:"利子ゲット",desc:"初めて利子をもらった",type:"action",check:s=>s.interestCount>=1},
  // ストリーク系
  {id:"b18",emoji:"🔥",name:"3日連続",desc:"3日連続でガチャを引いた",type:"streak",check:s=>s.maxStreak>=3},
  {id:"b19",emoji:"⚡",name:"週間チャンピオン",desc:"7日連続でガチャを引いた",type:"streak",check:s=>s.maxStreak>=7},
  {id:"b20",emoji:"🌟",name:"毎日パーフェクト",desc:"毎日タスクを全達成した日がある",type:"streak",check:s=>s.perfectDays>=1},
  // 追加バッジ（達成系）
  {id:"b21",emoji:"💫",name:"お手伝い30回",desc:"お手伝いを30回した",type:"achieve",check:s=>s.goodCount>=30},
  {id:"b22",emoji:"🌈",name:"2000ptクラブ",desc:"残高2000ptを達成した",type:"achieve",check:s=>s.maxBal>=2000},
  {id:"b23",emoji:"🏅",name:"3000ptクラブ",desc:"残高3000ptを達成した",type:"achieve",check:s=>s.maxBal>=3000},
  {id:"b24",emoji:"💰",name:"こうかん5回",desc:"こうかんを5回した",type:"action",check:s=>s.rewardCount>=5},
  {id:"b25",emoji:"🎯",name:"目標達成2回",desc:"目標貯金を2回達成した",type:"achieve",check:s=>s.goalsDone>=2},
  {id:"b26",emoji:"📅",name:"14日連続",desc:"14日連続でガチャを引いた",type:"streak",check:s=>s.maxStreak>=14},
  {id:"b27",emoji:"🗓",name:"30日連続",desc:"30日連続でガチャを引いた",type:"streak",check:s=>s.maxStreak>=30},
  {id:"b28",emoji:"🎪",name:"ガチャ10回",desc:"ガチャを10回引いた",type:"action",check:s=>s.gachaCount>=10},
  {id:"b29",emoji:"🎡",name:"ガチャ50回",desc:"ガチャを50回引いた",type:"action",check:s=>s.gachaCount>=50},
  {id:"b30",emoji:"📚",name:"まめちしき5回",desc:"まめちしきを5回読んだ",type:"action",check:s=>s.tipsRead>=5},
  {id:"b31",emoji:"📖",name:"まめちしき10回",desc:"まめちしきを10回読んだ",type:"action",check:s=>s.tipsRead>=10},
  {id:"b32",emoji:"🧠",name:"まめちしきマスター",desc:"まめちしきを20回読んだ",type:"action",check:s=>s.tipsRead>=20},
  {id:"b33",emoji:"🚀",name:"投資10回",desc:"株を売買10回した",type:"action",check:s=>s.investBuy+s.investSell>=10},
  {id:"b34",emoji:"🌙",name:"夜の投資家",desc:"株を売買30回した",type:"action",check:s=>s.investBuy+s.investSell>=30},
  {id:"b35",emoji:"💎",name:"お手伝い200回",desc:"お手伝いを200回した",type:"achieve",check:s=>s.goodCount>=200},
  {id:"b36",emoji:"👑",name:"10000ptキング",desc:"残高10000ptを達成した",type:"achieve",check:s=>s.maxBal>=10000},
  {id:"b37",emoji:"🌺",name:"パーフェクト5回",desc:"毎日タスクを5日全達成した",type:"streak",check:s=>s.perfectDays>=5},
  {id:"b38",emoji:"🏆",name:"パーフェクト10回",desc:"毎日タスクを10日全達成した",type:"streak",check:s=>s.perfectDays>=10},
  {id:"b39",emoji:"⭐",name:"利子10回",desc:"利子を10回もらった",type:"action",check:s=>s.interestCount>=10},
  {id:"b40",emoji:"🌠",name:"全部やる人",desc:"お手伝い・投資・こうかんを全部経験した",type:"achieve",check:s=>s.goodCount>=1&&s.investBuy>=1&&s.rewardCount>=1},
];

function BadgesSection({child,data,update}){
  const [filter,setFilter]=useState("all");
  const stats=calcBadgeStats(child,data);
  const badges=ALL_BADGES.map(b=>({...b,earned:b.check(stats)}));
  const earned=badges.filter(b=>b.earned);
  const filtered=filter==="all"?badges:filter==="locked"?badges.filter(b=>!b.earned):badges.filter(b=>b.type===filter);

  // バッジ獲得ポイント（1バッジ=5pt）をまだもらっていないバッジ分だけ付与
  const BADGE_PT = 5;
  const claimedBadges = (data.claimedBadges||{})[child.id]||[];
  const newlyEarned = earned.filter(b=>!claimedBadges.includes(b.id));
  React.useEffect(()=>{
    if(newlyEarned.length===0||!update) return;
    const pts = newlyEarned.length * BADGE_PT;
    const newIds = newlyEarned.map(b=>b.id);
    const entry = {id:uid(),cid:child.id,type:"badge",label:`🏅 バッジ獲得ボーナス（${newlyEarned.map(b=>b.emoji).join("")}）`,pts,date:new Date().toISOString()};
    update(d=>({
      ...d,
      logs:[entry,...d.logs],
      claimedBadges:{...(d.claimedBadges||{}),[child.id]:[...(d.claimedBadges?.[child.id]||[]),...newIds]}
    }));
    addLogToFirestore(entry);
  },[earned.length]);
  return(<div style={{padding:"12px 16px"}}>
    <div style={{background:`linear-gradient(135deg,${Y}20,${G}15)`,border:`1.5px solid ${Y}`,borderRadius:18,padding:"14px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:14}}>
      <div style={{fontSize:40}}>🎖</div>
      <div><div style={{fontWeight:900,fontSize:22,color:TEXT}}>{earned.length}<span style={{fontSize:14,color:MUTED,fontWeight:700}}>/{badges.length}</span></div><div style={{color:MUTED,fontSize:12}}>バッジを獲得中！</div></div>
      <div style={{flex:1}}><div style={{height:10,background:BORDER,borderRadius:5,overflow:"hidden"}}><div style={{height:"100%",width:`${earned.length/badges.length*100}%`,background:`linear-gradient(90deg,${Y},${G})`,borderRadius:5}}/></div><div style={{color:MUTED,fontSize:11,marginTop:4,textAlign:"right"}}>{Math.round(earned.length/badges.length*100)}%達成</div></div>
    </div>
    <div style={{marginBottom:12}}><SortBar options={[["all","すべて"],["achieve","達成系"],["action","行動系"],["locked","未獲得"]]} value={filter} onChange={setFilter}/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      {filtered.map(b=>(
        <div key={b.id} style={{background:b.earned?CARD:BG,border:`2px solid ${b.earned?(b.type==="achieve"?Y:G):BORDER}`,borderRadius:16,padding:"14px 12px",textAlign:"center",opacity:b.earned?1:0.5,position:"relative"}}>
          {b.earned&&<div style={{position:"absolute",top:-6,right:-6,width:18,height:18,borderRadius:"50%",background:G,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#fff",fontWeight:900}}>✓</div>}
          <img src={`/assets/badge_${b.id}.png`} alt={b.name} style={{width:52,height:52,objectFit:"contain",display:"block",margin:"0 auto 6px",borderRadius:8,filter:b.earned?"none":"grayscale(1) opacity(0.35)"}}/>
          <div style={{fontWeight:800,fontSize:12,color:b.earned?TEXT:MUTED,marginBottom:4,lineHeight:1.3}}>{b.name}</div>
          <div style={{fontSize:10,color:MUTED,lineHeight:1.4}}>{b.desc}</div>
        </div>
      ))}
    </div>
  </div>);
}

// ── Tips ──────────────────────────────────────────────
const ALL_TIPS=[
  {id:"t01",cat:"お金のきほん",emoji:"💴",title:"お金ってなに？",body:"お金は「ものやサービスと交換できる券」だよ。昔は貝殻や石が使われていたんだ！"},
  {id:"t02",cat:"お金のきほん",emoji:"🏦",title:"銀行の仕組み",body:"銀行にお金を預けると、銀行はそのお金を別の人に貸して利息をとる。その一部をあなたに「利子」として払ってくれるよ。"},
  {id:"t03",cat:"お金のきほん",emoji:"💳",title:"クレジットカードの仕組み",body:"クレジットカードは「後払い」の仕組み。使った分は翌月に口座から引き落とされるよ。使いすぎに注意！"},
  {id:"t04",cat:"お金のきほん",emoji:"📊",title:"物価ってなに？",body:"物の値段のことを「物価」という。お金が世の中に増えすぎると物価が上がる「インフレ」が起きるよ。"},
  {id:"t05",cat:"お金のきほん",emoji:"🌐",title:"為替ってなに？",body:"1ドル=150円のように、国によってお金の価値が違う。この交換レートを「為替」という。円安になると輸入品が高くなるよ。"},
  {id:"t06",cat:"お金のきほん",emoji:"🧾",title:"税金の種類",body:"消費税・所得税・住民税など税金は種類がたくさん。集まった税金は学校・道路・病院などに使われるよ。"},
  {id:"t07",cat:"お金のきほん",emoji:"💰",title:"お金を稼ぐ3つの方法",body:"①労働（働く）②投資（お金を増やす）③事業（商売をする）。この3つを組み合わせると豊かになりやすいよ！"},
  {id:"t08",cat:"貯金・節約",emoji:"🐷",title:"貯金のコツ",body:"もらったら先に貯金する「先取り貯金」が効果的。使った残りを貯めようとすると、つい使い切ってしまうよ。"},
  {id:"t09",cat:"貯金・節約",emoji:"📝",title:"家計簿をつけよう",body:"何にいくら使ったか記録するだけで、無駄遣いに気づける。1週間試すだけで節約できる金額がわかるよ！"},
  {id:"t10",cat:"貯金・節約",emoji:"🎯",title:"目標を決めると貯まりやすい",body:"「3000ptでゲームを買う」など具体的な目標があると、貯金が続きやすい。目的のない貯金は途中でやめがちだよ。"},
  {id:"t11",cat:"貯金・節約",emoji:"⚖",title:"欲しいvs必要",body:"ものを買う前に「欲しいもの？必要なもの？」と考えよう。欲しいものは後回しにすると、本当に必要かわかるよ。"},
  {id:"t12",cat:"貯金・節約",emoji:"🔄",title:"複利の魔法",body:"利子にさらに利子がつく「複利」はとても強力。100ptを年5%で運用すると20年後には約265ptになるよ！"},
  {id:"t13",cat:"投資",emoji:"📈",title:"株ってなに？",body:"株は会社の「一部オーナー権」。会社が成長すると株価が上がり、持っているだけで「配当金」ももらえることがあるよ。"},
  {id:"t14",cat:"投資",emoji:"🎲",title:"リスクとリターン",body:"大きく儲かるものほどリスクも大きい。株より預金は安全だけど増えにくい。自分のリスク許容度を知ることが大切。"},
  {id:"t15",cat:"投資",emoji:"🧺",title:"卵は1つのカゴに盛るな",body:"投資の有名な格言。1つの銘柄だけに全部つぎ込むのは危険。複数に分けて投資することを「分散投資」というよ。"},
  {id:"t16",cat:"投資",emoji:"⏳",title:"長期投資が強い理由",body:"短期の株価は予測できないが、長期的に見ると良い会社の株は成長する傾向がある。焦らずじっくり持つのが基本。"},
  {id:"t17",cat:"投資",emoji:"🤔",title:"なぜ企業は株を発行するの？",body:"会社は成長するためのお金が必要。株を売ってお金を集める代わりに、投資家に利益を分けることを約束するよ。"},
  {id:"t18",cat:"投資",emoji:"📉",title:"株が下がるのはなぜ？",body:"業績悪化・経済不安・金利上昇・戦争などが原因。みんなが「将来不安だ」と思うと株を売るので価格が下がるよ。"},
  {id:"t19",cat:"社会・経済",emoji:"🌍",title:"世界の経済はつながっている",body:"アメリカで不景気が起きると日本の株も下がる。世界の経済はインターネット同様つながっているんだよ。"},
  {id:"t20",cat:"社会・経済",emoji:"🏭",title:"モノの値段が決まる仕組み",body:"「需要（欲しい人）」と「供給（売りたい量）」のバランスで価格が決まる。欲しい人が多いほど高くなるよ。"},
  {id:"t21",cat:"社会・経済",emoji:"🤖",title:"AIと仕事の未来",body:"AIの発展で一部の仕事はなくなる。でも新しい仕事も生まれる。大切なのは「考える力」と「学び続ける力」だよ。"},
  {id:"t22",cat:"社会・経済",emoji:"♻",title:"ESG投資ってなに？",body:"環境(E)・社会(S)・企業統治(G)に配慮した企業に投資すること。地球にいい企業を応援しながら増やせるよ。"},
  {id:"t23",cat:"社会・経済",emoji:"📱",title:"デジタルマネーの時代",body:"PayPayやクレカで現金を使わない人が増えている。便利な反面、使いすぎに気づきにくいので注意が必要だよ。"},
  {id:"t24",cat:"働くこと",emoji:"💼",title:"給料ってどう決まる？",body:"スキル・経験・業界・会社の規模などで変わる。同じ仕事でも会社によって全然違うことも。副業も増えているよ。"},
  {id:"t25",cat:"働くこと",emoji:"🌱",title:"お手伝いは社会の練習",body:"お手伝いは実はすごく大事。責任感・計画性・達成感を学べる。これが将来の仕事への基礎になるよ！"},
  {id:"t26",cat:"働くこと",emoji:"🤝",title:"価値を作るとお金になる",body:"人が「欲しい・助かる」と思うものを作ったり、サービスを提供したりすることで対価（お金）がもらえるよ。"},
  {id:"t27",cat:"働くこと",emoji:"📚",title:"勉強がお金につながる理由",body:"知識・スキルは「人的資本」。勉強に使うお金は投資と同じ。学べば学ぶほど将来稼げる可能性が上がるよ。"},
  {id:"t28",cat:"Tane Money",emoji:"🌱",title:"Tane Moneyのコンセプト",body:"「お金は種」。種を蒔いて育てるように、小さなお手伝いの積み重ねが大きな力になる。毎日コツコツが一番！"},
  {id:"t29",cat:"Tane Money",emoji:"🏆",title:"ランキングで成長できる理由",body:"家族でランキングを競うことで「やる気」が生まれる。競争ではなく「昨日の自分より成長する」ことが大切。"},
  {id:"t30",cat:"Tane Money",emoji:"🎰",title:"ガチャから学べること",body:"ガチャは「確率」の練習。毎日引き続けると結果が安定してくる。これが長期投資と同じ考え方だよ！"},
];

function TipsSection({ageMode,child,data,update}){
  const [cat,setCat]=useState("すべて");
  const [openId,setOpenId]=useState(null);
  const readIds=(data.tipsRead||{})[child.id]||[];
  const TIP_PTS=5;
  const ageCats=ageMode==="young"?["お金のきほん","貯金・節約","Tane Money"]:null;
  const cats=["すべて",...Array.from(new Set(ALL_TIPS.map(t=>t.cat)))];
  const filtered=ALL_TIPS.filter(t=>(ageCats?ageCats.includes(t.cat):true)&&(cat==="すべて"||t.cat===cat));
  const totalRead=readIds.filter(id=>ALL_TIPS.find(t=>t.id===id)).length;
  const handleOpen=tipId=>{
    if(openId===tipId){setOpenId(null);return;}
    setOpenId(tipId);
    if(!readIds.includes(tipId)){
      update(d=>({...d,tipsRead:{...(d.tipsRead||{}),[child.id]:[...(d.tipsRead?.[child.id]||[]),tipId]},logs:(()=>{const _e={id:uid(),cid:child.id,type:"tips",label:`💡 まめちしき読んだ！+${TIP_PTS}pt`,pts:TIP_PTS,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})()}));
    }
  };
  return(<div style={{padding:"12px 16px"}}>
    <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontSize:20}}>💡</span>
      <div style={{flex:1}}><div style={{fontWeight:800,fontSize:15,color:TEXT}}>まめちしき</div><div style={{color:MUTED,fontSize:11}}>{filtered.length}件 · タップで詳しく読む</div></div>
      <div style={{background:`${G}15`,border:`1.5px solid ${G}`,borderRadius:12,padding:"4px 10px",textAlign:"center"}}>
        <div style={{fontWeight:900,fontSize:14,color:G}}>{totalRead}<span style={{fontSize:10,color:MUTED}}>/{ALL_TIPS.length}</span></div>
        <div style={{fontSize:9,color:MUTED}}>読了</div>
      </div>
    </div>
    <div style={{background:`${Y}15`,border:`1.5px solid ${Y}`,borderRadius:12,padding:"8px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <span style={{fontSize:12,color:TEXT,fontWeight:700}}>📚 読んで獲得したpt</span>
      <span style={{fontWeight:900,fontSize:15,color:Y}}>+{(totalRead*TIP_PTS).toLocaleString()}pt</span>
    </div>
    <div style={{marginBottom:14}}><SortBar options={cats.filter(c=>ageCats?ageCats.includes(c)||c==="すべて":true).map(c=>[c,c])} value={cat} onChange={setCat}/></div>
    {filtered.map(tip=>{
      const isOpen=openId===tip.id;
      const isRead=readIds.includes(tip.id);
      return(<button key={tip.id} onClick={()=>handleOpen(tip.id)}
        style={{width:"100%",background:isOpen?`${B}10`:isRead?`${G}08`:CARD,border:`1.5px solid ${isOpen?B:isRead?G:BORDER}`,borderRadius:16,padding:"13px 14px",marginBottom:8,textAlign:"left",cursor:"pointer",fontFamily:F,transition:"all .2s"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22,flexShrink:0}}>{tip.emoji}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:13,color:isOpen?B:TEXT}}>{tip.title}</div>
            <div style={{display:"flex",gap:6,marginTop:3,alignItems:"center"}}>
              <span style={{background:`${B}20`,color:B,padding:"1px 6px",borderRadius:8,fontWeight:700,fontSize:10}}>{tip.cat}</span>
              {!isRead&&<span style={{background:`${Y}20`,color:"#9a7000",padding:"1px 6px",borderRadius:8,fontWeight:700,fontSize:10}}>+{TIP_PTS}pt</span>}
              {isRead&&<span style={{color:G,fontSize:10,fontWeight:700}}>✓ 読んだ</span>}
            </div>
          </div>
          <span style={{color:MUTED,fontSize:14,flexShrink:0,transform:isOpen?"rotate(180deg)":"none",transition:"transform .2s"}}>▼</span>
        </div>
        {isOpen&&<div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${B}30`,fontSize:13,color:TEXT,lineHeight:1.8,fontWeight:500}}>
          {tip.body}
          {!isRead&&<div style={{marginTop:8,background:`${G}15`,border:`1px solid ${G}`,borderRadius:8,padding:"6px 10px",display:"inline-block",fontSize:12,color:G,fontWeight:700}}>🎉 +{TIP_PTS}pt ゲット！</div>}
        </div>}
      </button>);
    })}
  </div>);
}

// ── TaskCustomizer ────────────────────────────────────
function TaskCustomizer({child,data,update,onClose}){
  const allGood=data.goodTasks||[];
  const allBad=data.badTasks||[];
  const myIds=(data.myTaskIds||{})[child.id]||[];
  const isAll=myIds.length===0;
  const [selected,setSelected]=useState(isAll?[...allGood.map(t=>t.id),...allBad.map(t=>t.id)]:myIds);
  const [section,setSection]=useState("good");
  const toggle=id=>setSelected(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
  const selectSection=kind=>{const ids=(kind==="good"?allGood:allBad).map(t=>t.id);setSelected(prev=>[...new Set([...prev,...ids])]);};
  const clearSection=kind=>{const ids=new Set((kind==="good"?allGood:allBad).map(t=>t.id));setSelected(prev=>prev.filter(id=>!ids.has(id)));};
  const save=()=>{const allIds=[...allGood.map(t=>t.id),...allBad.map(t=>t.id)];const val=selected.length===allIds.length?[]:selected;update(d=>({...d,myTaskIds:{...(d.myTaskIds||{}),[child.id]:val}}));onClose();};
  const goodSel=allGood.filter(t=>selected.includes(t.id)).length;
  const badSel=allBad.filter(t=>selected.includes(t.id)).length;
  const col=section==="good"?G:R;
  const currentList=section==="good"?allGood:allBad;
  return(<div style={{position:"fixed",inset:0,background:"#0009",zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}}>
    <div style={{background:CARD,borderRadius:"24px 24px 0 0",width:"100%",maxWidth:440,maxHeight:"90vh",display:"flex",flexDirection:"column",boxShadow:"0 -8px 40px #0004"}}>
      <div style={{padding:"18px 20px 12px",borderBottom:`1px solid ${BORDER}`}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <h3 style={{fontWeight:900,fontSize:17,margin:0,color:TEXT}}>{child.emoji} マイタスクリスト</h3>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>✕</button>
        </div>
        <p style={{color:MUTED,fontSize:12,margin:"0 0 12px",lineHeight:1.6}}>自分が管理したいタスクをチェックしよう。</p>
        <div style={{display:"flex",gap:0,background:BG,borderRadius:12,overflow:"hidden",marginBottom:10}}>
          {[["good",`✅ プラス（${goodSel}/${allGood.length}）`],["bad",`❌ マイナス（${badSel}/${allBad.length}）`]].map(([v,l])=>(
            <button key={v} onClick={()=>setSection(v)} style={{flex:1,padding:"9px 0",border:"none",background:section===v?(v==="good"?G:R):"transparent",color:section===v?"#fff":MUTED,fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>selectSection(section)} style={{flex:1,padding:"6px 0",border:`1.5px solid ${col}`,borderRadius:10,background:`${col}15`,color:col,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>全選択</button>
          <button onClick={()=>clearSection(section)} style={{flex:1,padding:"6px 0",border:`1.5px solid ${BORDER}`,borderRadius:10,background:"transparent",color:MUTED,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>全解除</button>
        </div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"12px 20px"}}>
        {currentList.map(t=>{const on=selected.includes(t.id);return(
          <button key={t.id} onClick={()=>toggle(t.id)} style={{width:"100%",background:on?`${col}10`:BG,border:`2px solid ${on?col:BORDER}`,borderRadius:14,padding:"11px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left",fontFamily:F,transition:"all .15s"}}>
            <span style={{fontSize:22,flexShrink:0}}>{t.emoji}</span>
            <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14,color:on?col:TEXT}}>{t.label}</div><div style={{color:MUTED,fontSize:11,marginTop:1}}>{t.pts>0?"+":""}{t.pts}pt</div></div>
            <div style={{width:24,height:24,borderRadius:6,border:`2px solid ${on?col:BORDER}`,background:on?col:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on&&<span style={{color:"#fff",fontSize:14,fontWeight:900}}>✓</span>}</div>
          </button>
        );})}
      </div>
      <div style={{padding:"12px 20px 32px",borderTop:`1px solid ${BORDER}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <span style={{color:MUTED,fontSize:12}}>合計 {selected.length}個を選択中</span>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setSelected([...allGood.map(t=>t.id),...allBad.map(t=>t.id)])} style={{padding:"4px 10px",border:`1px solid ${G}`,borderRadius:8,background:"transparent",color:G,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>全選択</button>
            <button onClick={()=>setSelected([])} style={{padding:"4px 10px",border:`1px solid ${BORDER}`,borderRadius:8,background:"transparent",color:MUTED,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>全解除</button>
          </div>
        </div>
        <button onClick={save} style={{width:"100%",background:G,border:"none",borderRadius:14,padding:"14px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>✅ このリストで決定！</button>
      </div>
    </div>
  </div>);
}


// ── Setup Wizard ──────────────────────────────────────
function SetupWizard({ data, update, onComplete }) {
  const [step,          setStep]         = useState(0);
  const [familyName,    setFamilyName]   = useState("");
  const [childName,     setChildName]    = useState("");
  const [childEmoji,    setChildEmoji]   = useState("⚡");
  const [childMode,     setChildMode]    = useState("teen");
  const [selectedTasks, setSelectedTasks]= useState([]);
  const [goalEmoji,     setGoalEmoji]    = useState("🎮");
  const [goalLabel,     setGoalLabel]    = useState("");
  const [goalTarget,    setGoalTarget]   = useState("");
  const [goalSkipped,   setGoalSkipped]  = useState(false);

  const [familyCode] = useState(()=>`TANE-${Math.random().toString(36).slice(2,6).toUpperCase()}`);
  const [joinMode, setJoinMode] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinErr,  setJoinErr]  = useState("");

  const CHILD_EMOJIS = ["⚡","🌸","🌟","🦁","🐯","🐬","🦊","🐼","🐉","🌈","🎸","⚽","🚀","🎮","🦄","🐶","🐱","🍕"];
  const GOAL_EMOJIS  = ["🎮","📱","🎵","🚴","✈","👟","📚","🎨","⚽","🍰","💻","🎸","🏊","🎀","🌍","🍜"];
  const STARTER_TASKS = (data?.goodTasks||[]).slice(0,10);

  const handleComplete = (skipGoal=false, parentPin="0000") => {
    const childId = uid();
    const newChild = {
      id:childId, name:childName.trim()||"こども", emoji:childEmoji,
      pin:"0000", displayMode:childMode, role:"child",
      gradeLabel:childMode==="junior"?"小学生":"中学生",
      ageMode:childMode==="junior"?"young":"middle",
      permissions:{canChangePin:true,canViewBalance:true,canCreateGoals:true,canRedeemRewards:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"},
    };
    const newGoal = !skipGoal && goalLabel.trim() && parseInt(goalTarget)>0
      ? {id:uid(),cid:childId,emoji:goalEmoji,label:goalLabel.trim(),target:parseInt(goalTarget),done:false}
      : null;
    const bonusLog = {id:uid(),cid:childId,type:"grant",label:"🎉 タネマネースタートボーナス！",pts:100,date:new Date().toISOString()};

    try { localStorage.setItem(FAMILY_CODE_KEY, familyCode); } catch(e){}
    _familyCode = familyCode;

    update(d=>({
      ...d,
      children:[newChild], parents:[],
      goals:newGoal?[newGoal]:[],
      myTaskIds:selectedTasks.length>0?{[childId]:selectedTasks}:{},
      tutorialSeen:{[childId]:true},
      setupComplete:true,
      parentPin: parentPin||"0000",
      logs:[bonusLog],
      gachaDate:{}, streak:{},
    }));
    addLogToFirestore(bonusLog);
    onComplete();
  };

  const btnStyle = (ok) => ({
    width:"100%",background:ok?GP:BORDER,border:"none",borderRadius:16,
    padding:"15px",color:ok?"#fff":MUTED,fontWeight:900,fontSize:16,
    cursor:ok?"pointer":"default",fontFamily:F,transition:"all .2s",
  });

  return (
    <div style={{minHeight:"100vh",background:`linear-gradient(160deg,${GS} 0%,#fff 50%,${GOLDS} 100%)`,fontFamily:F,display:"flex",flexDirection:"column",padding:"56px 24px 40px",maxWidth:480,margin:"0 auto",boxSizing:"border-box"}}>

      {/* プログレスバー (step 1〜5) */}
      {step>=1&&step<=5&&(
        <div style={{marginBottom:28}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:11,color:MUTED,fontWeight:700}}>ステップ {step} / 5</span>
            {step<5&&<button onClick={()=>setStep(s=>s-1)} style={{background:"none",border:"none",color:GP,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F}}>← もどる</button>}
          </div>
          <div style={{background:BORDER,borderRadius:999,height:6,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${step/5*100}%`,background:G,borderRadius:999,transition:"width .4s ease"}}/>
          </div>
        </div>
      )}

      {/* Step 0: ようこそ */}
      {step===0&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center"}}>
          <div style={{fontSize:88,marginBottom:16,lineHeight:1}}>🌱</div>
          <h1 style={{fontWeight:900,fontSize:30,color:GP,margin:"0 0 14px",lineHeight:1.2,fontFamily:FB}}>Tane Money</h1>
          <p style={{color:TEXTS,fontSize:15,lineHeight:1.9,margin:"0 0 12px",maxWidth:280}}>
            家族みんなで楽しく<br/>お金のことを学ぼう！
          </p>
          <p style={{color:MUTED,fontSize:12,margin:"0 0 28px"}}>⏱ セットアップは約3分で完了</p>
          <button onClick={()=>setStep(1)} style={{...btnStyle(true),fontSize:18,padding:"17px",boxShadow:`0 8px 24px ${GP}40`,marginBottom:16}}>
            はじめる 🌟
          </button>
          {!joinMode&&(
            <button onClick={()=>setJoinMode(true)} style={{background:"none",border:"none",color:MUTED,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F,textDecoration:"underline"}}>
              すでにファミリーコードがある →
            </button>
          )}
          {joinMode&&(
            <div style={{width:"100%",maxWidth:320,background:CARD,borderRadius:18,padding:"20px",border:`1.5px solid ${BORDER}`,textAlign:"left",marginTop:4}}>
              <p style={{fontWeight:800,fontSize:14,color:TEXT,margin:"0 0 10px",textAlign:"center"}}>🔗 ファミリーコードを入力</p>
              <input value={joinCode} onChange={e=>{setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9\-]/g,""));setJoinErr("");}}
                placeholder="TANE-XXXX"
                style={{...{width:"100%",padding:"12px 14px",border:`1.5px solid ${joinErr?R:BORDER}`,borderRadius:10,fontSize:16,fontFamily:F,background:BG,outline:"none",textAlign:"center",letterSpacing:3,fontWeight:900,color:GP,boxSizing:"border-box"},marginBottom:8}}/>
              {joinErr&&<p style={{color:R,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>{joinErr}</p>}
              <button onClick={()=>{
                const code=joinCode.trim();
                if(!code||code.length<4){setJoinErr("コードを入力してください");return;}
                try{localStorage.setItem(FAMILY_CODE_KEY,code);}catch(e){}
                _familyCode=code;
                onComplete();
              }} style={{...btnStyle(joinCode.trim().length>=4),marginBottom:8}}>
                参加する →
              </button>
              <button onClick={()=>{setJoinMode(false);setJoinCode("");setJoinErr("");}} style={{background:"none",border:"none",color:MUTED,fontSize:12,cursor:"pointer",fontFamily:F,width:"100%",textAlign:"center"}}>
                キャンセル
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 1: ファミリー名 */}
      {step===1&&(
        <div style={{flex:1}}>
          <div style={{fontSize:48,marginBottom:14}}>🏠</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>ファミリー名を決めよう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 22px",lineHeight:1.6}}>あとで変えることもできます</p>
          <input value={familyName} onChange={e=>setFamilyName(e.target.value)}
            placeholder="例：田中家、くるりんファミリー"
            style={{...INP,fontSize:15,marginBottom:14}}/>
          {familyName.trim()&&(
            <div style={{background:GS,border:`1.5px solid ${G}`,borderRadius:14,padding:"12px 16px",marginBottom:22}}>
              <div style={{fontSize:11,color:MUTED,marginBottom:4}}>接続コード（家族でシェアして使います）</div>
              <div style={{fontWeight:900,fontSize:18,color:GP,letterSpacing:2}}>{familyCode}</div>
              <div style={{fontSize:10,color:MUTED,marginTop:4}}>このコードを他の端末で入力すると同じデータを使えます</div>
            </div>
          )}
          <button onClick={()=>setStep(2)} style={btnStyle(!!familyName.trim())} disabled={!familyName.trim()}>
            つぎへ →
          </button>
        </div>
      )}

      {/* Step 2: 子どもを追加 */}
      {step===2&&(
        <div style={{flex:1}}>
          <div style={{fontSize:48,marginBottom:14}}>👦</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>子どもを追加しよう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 16px"}}>あとで何人でも追加できます</p>
          <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8}}>絵文字を選ぼう</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:16}}>
            {CHILD_EMOJIS.map(e=>(
              <button key={e} onClick={()=>setChildEmoji(e)} style={{width:42,height:42,borderRadius:11,border:`2.5px solid ${childEmoji===e?GP:BORDER}`,background:childEmoji===e?`${GP}18`:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {e}
              </button>
            ))}
          </div>
          <input value={childName} onChange={e=>setChildName(e.target.value)}
            placeholder="名前（例：かなと）"
            style={{...INP,fontSize:15,marginBottom:12}}/>
          <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8}}>年代</div>
          <div style={{display:"flex",gap:8,marginBottom:24}}>
            {[["junior","小学生"],["teen","中学生・高校生"]].map(([v,l])=>(
              <button key={v} onClick={()=>setChildMode(v)} style={{flex:1,padding:"11px 0",border:`2px solid ${childMode===v?GP:BORDER}`,borderRadius:12,background:childMode===v?`${GP}15`:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F,color:childMode===v?GP:MUTED,transition:"all .15s"}}>
                {l}
              </button>
            ))}
          </div>
          <button onClick={()=>setStep(3)} style={btnStyle(!!childName.trim())} disabled={!childName.trim()}>
            つぎへ →
          </button>
        </div>
      )}

      {/* Step 3: お手伝いを選ぶ */}
      {step===3&&(
        <div style={{flex:1}}>
          <div style={{fontSize:48,marginBottom:14}}>✅</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>お手伝いを選ぼう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 16px"}}>やってみたいものを選んでね！（あとで変えられます）</p>
          <div style={{marginBottom:20,maxHeight:340,overflowY:"auto"}}>
            {STARTER_TASKS.map(t=>{
              const sel=selectedTasks.includes(t.id);
              return(
                <button key={t.id} onClick={()=>setSelectedTasks(p=>sel?p.filter(x=>x!==t.id):[...p,t.id])}
                  style={{width:"100%",marginBottom:8,background:sel?`${GP}12`:"#fff",border:`2px solid ${sel?GP:BORDER}`,borderRadius:13,padding:"10px 14px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left",fontFamily:F,transition:"all .15s"}}>
                  <span style={{fontSize:22,flexShrink:0}}>{t.emoji}</span>
                  <span style={{flex:1,fontWeight:700,fontSize:13,color:TEXT}}>{t.label}</span>
                  <span style={{fontSize:12,color:GP,fontWeight:800,flexShrink:0}}>+{t.pts}pt</span>
                  {sel&&<span style={{color:GP,fontSize:16,fontWeight:900,flexShrink:0}}>✓</span>}
                </button>
              );
            })}
          </div>
          <button onClick={()=>setStep(4)} style={btnStyle(true)}>
            {selectedTasks.length===0?"スキップ →":`${selectedTasks.length}個選択 → つぎへ`}
          </button>
        </div>
      )}

      {/* Step 4: 最初の目標 */}
      {step===4&&(
        <div style={{flex:1}}>
          <div style={{fontSize:48,marginBottom:14}}>🎯</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>はじめての目標を決めよう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 16px",lineHeight:1.6}}>何のために貯める？<br/>スキップしてあとで設定もOK！</p>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:14}}>
            {GOAL_EMOJIS.map(e=>(
              <button key={e} onClick={()=>setGoalEmoji(e)} style={{width:42,height:42,borderRadius:11,border:`2.5px solid ${goalEmoji===e?GOLD:BORDER}`,background:goalEmoji===e?GOLDS:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {e}
              </button>
            ))}
          </div>
          <input value={goalLabel} onChange={e=>setGoalLabel(e.target.value)}
            placeholder="例：ゲーム、自転車、旅行" style={{...INP,fontSize:15,marginBottom:10}}/>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:22}}>
            <input value={goalTarget} onChange={e=>setGoalTarget(e.target.value)} type="number"
              placeholder="目標pt（例：500）" style={{...INP,flex:1,fontSize:15}}/>
            <span style={{fontSize:13,color:MUTED,fontWeight:700,flexShrink:0}}>pt</span>
          </div>
          <button onClick={()=>{setGoalSkipped(false);setStep(5);}} style={{...btnStyle(true),marginBottom:10,background:GP,boxShadow:`0 6px 20px ${GP}40`}}>
            次へ → PIN設定
          </button>
          <button onClick={()=>{setGoalSkipped(true);setStep(5);}} style={{width:"100%",background:"transparent",border:"none",color:MUTED,fontSize:13,cursor:"pointer",fontFamily:F,fontWeight:700,padding:"6px"}}>
            スキップしてPIN設定へ
          </button>
        </div>
      )}

      {/* Step 5: おや用PIN設定 */}
      {step===5&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center"}}>
          <div style={{fontSize:56,marginBottom:16}}>🔐</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 8px"}}>おや用PINを設定しよう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 28px",lineHeight:1.7}}>子どもに見られないよう<br/>4けたの番号を決めよう</p>
          <PinInput onDone={pin=>handleComplete(goalSkipped,pin)}/>
          <button onClick={()=>handleComplete(goalSkipped,"0000")} style={{width:"100%",background:"transparent",border:"none",color:MUTED,fontSize:12,cursor:"pointer",fontFamily:F,fontWeight:700,padding:"20px 0 0"}}>
            スキップして後で設定する
          </button>
        </div>
      )}
    </div>
  );
}

// ── Tutorial ──────────────────────────────────────────
const CHILD_TUTORIAL = [
  {
    emoji:"🌱", title:"Tane Moneyへようこそ！",
    body:"お手伝いをするとポイントがもらえるよ。ポイントを貯めて、好きなものと交換しよう！",
    hint:"種（tane）を蒔くように、毎日コツコツ続けることが大切だよ🌟"
  },
  {
    emoji:"🏆", title:"お手伝いでポイントをゲット",
    body:"「活動」タブを開いて、やったお手伝いをタップしよう。ポイントがどんどん貯まるよ！",
    hint:"プラスのお手伝いもマイナスもあるよ。正直に記録しよう💪"
  },
  {
    emoji:"🎰", title:"毎日ガチャを引こう！",
    body:"「ガチャ」タブで毎日ガチャが引けるよ。毎日続けるとストリーク（連続日数）が増えるよ！",
    hint:"連続3日以上続けると🔥マークがつくよ"
  },
  {
    emoji:"💰", title:"ポイントを使ってみよう",
    body:"「お金」タブの「こうかん」で、貯めたポイントをご褒美と交換できるよ！",
    hint:"目標を作って計画的に貯めると達成感が大きいよ🎯"
  },
  {
    emoji:"📈", title:"投資にも挑戦してみよう",
    body:"「活動」→「投資」タブで、本物の会社の株をポイントで買えるよ。世界の経済を体感しよう！",
    hint:"分散投資・長期投資がポイント。まめちしきで勉強しよう💡"
  },
];

const PARENT_TUTORIAL = [
  {
    emoji:"🔐", title:"Tane Money 管理へようこそ",
    body:"ここは親専用の管理画面です。子どものポイントや毎日タスク、ルールを設定できます。",
    hint:"暗証番号：0000（初回は必ず変更してください）"
  },
  {
    emoji:"👦", title:"子どもの設定",
    body:"「こども」タブで名前・写真・暗証番号・ロックのON/OFFを設定できます。",
    hint:"ロックOFFなら暗証番号なしで子どものページに入れます"
  },
  {
    emoji:"📋", title:"毎日タスクを設定しよう",
    body:"「毎日」タブで、毎日こなすべきタスクを設定できます。全部クリアするとボーナスポイントがもらえます。",
    hint:"お手伝い項目から選ぶか、手動で自由に追加できます"
  },
  {
    emoji:"🏆", title:"タスクとご褒美の管理",
    body:"「タスク」タブでお手伝い項目を追加・編集。「特典」タブでご褒美の交換メニューを管理できます。",
    hint:"子どもごとに個別ポイントを設定することもできます"
  },
  {
    emoji:"📊", title:"ランキングで家族を盛り上げよう",
    body:"「ランキング」タブで今月の頑張りをみんなで確認！親も参加できるので家族全員で競いましょう。",
    hint:"違反記録・利子設定・ポイント付与も管理画面から行えます"
  },
];

function Tutorial({ isParent, name, emoji, onDone, onBonus }) {
  const slides = isParent ? PARENT_TUTORIAL : CHILD_TUTORIAL;
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const cur = slides[step];
  const isLast = step === slides.length - 1;

  const handleDone = () => {
    setDone(true);
    onBonus && onBonus();
    setTimeout(onDone, 1800);
  };

  if (done) return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32}}>
      <div style={{fontSize:72,marginBottom:16}}>🎉</div>
      <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 8px"}}>チュートリアル完了！</h2>
      <p style={{color:MUTED,fontSize:14,textAlign:"center",marginBottom:24}}>さあ、Tane Moneyを始めよう！</p>
      {!isParent && <div style={{background:`${G}20`,border:`2px solid ${G}`,borderRadius:16,padding:"12px 32px",fontWeight:900,fontSize:18,color:G}}>+100pt ゲット！🌟</div>}
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column"}}>
      {/* Progress bar */}
      <div style={{height:4,background:BORDER}}>
        <div style={{height:"100%",width:`${(step+1)/slides.length*100}%`,background:`linear-gradient(90deg,${Y},${G})`,transition:"width .4s"}}/>
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"32px 28px"}}>
        {/* Step indicator */}
        <div style={{display:"flex",gap:8,marginBottom:32}}>
          {slides.map((_,i)=>(
            <div key={i} style={{width:i===step?24:8,height:8,borderRadius:4,background:i===step?Y:i<step?G:BORDER,transition:"all .3s"}}/>
          ))}
        </div>

        {/* Card */}
        <div style={{background:CARD,borderRadius:28,padding:"36px 28px",width:"100%",maxWidth:360,textAlign:"center",boxShadow:"0 8px 40px #0002",marginBottom:24}}>
          <div style={{fontSize:72,marginBottom:16}}>{cur.emoji}</div>
          <h2 style={{fontWeight:900,fontSize:20,color:TEXT,margin:"0 0 12px",lineHeight:1.3}}>{cur.title}</h2>
          <p style={{color:MUTED,fontSize:14,lineHeight:1.8,margin:"0 0 20px"}}>{cur.body}</p>
          <div style={{background:`${Y}15`,border:`1.5px solid ${Y}40`,borderRadius:12,padding:"10px 14px"}}>
            <p style={{margin:0,fontSize:12,color:"#9a7000",fontWeight:700,lineHeight:1.6}}>💡 {cur.hint}</p>
          </div>
        </div>

        {/* Buttons */}
        {isLast ? (
          <button onClick={handleDone}
            style={{width:"100%",maxWidth:360,background:`linear-gradient(135deg,${Y},${G})`,border:"none",borderRadius:16,padding:"16px",color:"#fff",fontWeight:900,fontSize:16,cursor:"pointer",fontFamily:F,boxShadow:`0 4px 20px ${G}50`}}>
            {isParent ? "管理画面に進む →" : "Tane Moneyを始める！🌱"}
          </button>
        ) : (
          <div style={{display:"flex",gap:12,width:"100%",maxWidth:360}}>
            {step > 0 && <button onClick={()=>setStep(s=>s-1)}
              style={{flex:1,background:CARD,border:`2px solid ${BORDER}`,borderRadius:14,padding:"14px",color:MUTED,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:F}}>
              ← もどる
            </button>}
            <button onClick={()=>setStep(s=>s+1)}
              style={{flex:2,background:Y,border:"none",borderRadius:14,padding:"14px",color:TEXT,fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>
              つぎへ →
            </button>
          </div>
        )}

        <button onClick={onDone} style={{marginTop:16,background:"none",border:"none",color:MUTED,fontSize:12,cursor:"pointer",fontFamily:F}}>
          スキップ
        </button>
      </div>
    </div>
  );
}

// ── TabHint ───────────────────────────────────────────
function TabHint({ id, text, data, update, cid }) {
  const seenKey = `hint_${id}`;
  const seen = (data.tutorialSeen||{})[seenKey];
  const [visible, setVisible] = useState(!seen);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    update(d => ({...d, tutorialSeen: {...(d.tutorialSeen||{}), [seenKey]: true}}));
  };

  return (
    <div style={{margin:"8px 16px 0",background:`${B}10`,border:`1.5px solid ${B}40`,borderRadius:12,padding:"10px 14px",display:"flex",alignItems:"flex-start",gap:10}}>
      <span style={{fontSize:18,flexShrink:0}}>💡</span>
      <p style={{margin:0,fontSize:12,color:B,fontWeight:700,lineHeight:1.6,flex:1}}>{text}</p>
      <button onClick={dismiss} style={{background:"none",border:"none",color:MUTED,fontSize:16,cursor:"pointer",flexShrink:0,padding:0}}>✕</button>
    </div>
  );
}


function PinInput({onDone}) {
  const [step,setStep]=useState("new");
  const [newPin,setNewPin]=useState("");
  const [conf,setConf]=useState("");
  const [err,setErr]=useState("");
  const cur=step==="new"?newPin:conf;
  const press=k=>{
    if(cur.length>=4) return;
    const next=cur+k;
    if(step==="new"){setNewPin(next);if(next.length===4)setTimeout(()=>{setStep("confirm");setConf("");setErr("");},200);}
    else{setConf(next);if(next.length===4)setTimeout(()=>{if(next===newPin){onDone(next);}else{setErr("一致しません");setConf("");setTimeout(()=>setErr(""),1500);}},200);}
  };
  return(
    <div style={{width:"100%",maxWidth:320,textAlign:"center"}}>
      <p style={{color:MUTED,fontSize:13,marginBottom:12}}>{step==="new"?"新しい暗証番号を入力":"もう一度同じ番号を入力"}</p>
      <div style={{display:"flex",gap:12,justifyContent:"center",marginBottom:20}}>
        {[0,1,2,3].map(i=><div key={i} style={{width:16,height:16,borderRadius:"50%",background:cur.length>i?Y:"transparent",border:`2.5px solid ${err?R:Y}`}}/>)}
      </div>
      {err&&<p style={{color:R,fontWeight:700,fontSize:13,marginBottom:8}}>{err}</p>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,68px)",gap:10,justifyContent:"center"}}>
        {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
          <button key={i} onClick={()=>{if(k==="⌫"){if(step==="new")setNewPin(p=>p.slice(0,-1));else setConf(p=>p.slice(0,-1));}else if(k!=="")press(String(k));}}
            style={{width:68,height:68,borderRadius:18,background:k===""?"transparent":CARD,border:k===""?"none":`2px solid ${BORDER}`,fontSize:22,fontWeight:700,color:TEXT,cursor:k===""?"default":"pointer",fontFamily:F}}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChildAvatar({ child, size=38, style={} }) {
  if (child && child.avatar) {
    return (
      <div style={{width:size,height:size,borderRadius:"50%",overflow:"hidden",flexShrink:0,border:`2px solid ${Y}`,...style}}>
        <img src={child.avatar} style={{width:"100%",height:"100%",objectFit:"cover"}} alt={child.name}/>
      </div>
    );
  }
  return <span style={{fontSize:size*0.85,flexShrink:0,...style}}>{child&&child.emoji||"👤"}</span>;
}

// Tane Money icon
const TANE_ICON = "data:image/png;base64,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";

// Safe write rule: always write to .tmp first, then rename
// Never use open('w') directly on production files

// ── Error Boundary ────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props){super(props);this.state={hasError:false,error:null};}
  static getDerivedStateFromError(e){return{hasError:true,error:e};}
  componentDidCatch(e,info){console.error("TaneMoney Error:",e,info);}
  render(){
    if(!this.state.hasError) return this.props.children;
    return(
      <div style={{minHeight:"100vh",background:"#f8f9fa",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,fontFamily:"sans-serif"}}>
        <div style={{fontSize:48,marginBottom:16}}>⚠</div>
        <h2 style={{color:"#333",marginBottom:8,fontSize:18}}>表示エラーが発生しました</h2>
        <p style={{color:"#666",fontSize:13,textAlign:"center",marginBottom:24,lineHeight:1.6}}>
          データを読み込めませんでした。<br/>
          Claude.aiのチャット画面から開いてください。<br/>
          または下のボタンでリセットできます。
        </p>
        <button onClick={()=>{
          try{localStorage.removeItem("tane_money_v9_local");}catch(e){}
          window.location.reload();
        }} style={{background:"#34c77b",border:"none",borderRadius:12,padding:"12px 28px",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:10}}>
          データをリセットして再起動
        </button>
        <button onClick={()=>window.location.reload()}
          style={{background:"transparent",border:"1px solid #ccc",borderRadius:12,padding:"10px 24px",color:"#666",fontWeight:700,fontSize:13,cursor:"pointer"}}>
          再読み込み
        </button>
        <details style={{marginTop:20,maxWidth:320,fontSize:11,color:"#999"}}>
          <summary style={{cursor:"pointer"}}>エラー詳細</summary>
          <pre style={{whiteSpace:"pre-wrap",wordBreak:"break-all",marginTop:8}}>{this.state.error?.message}</pre>
        </details>
      </div>
    );
  }
}

export default function App() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncSt,  setSyncSt]  = useState("saved"); // saving | saved | error
  const [screen,  setScreen]  = useState("home");
  const [activeChild, setActiveChild] = useState(null);

  // Load from cloud on mount
  useEffect(()=>{
    // _familyCodeをlocalStorageから直接設定してからcloudLoadを呼ぶ
    try {
      const code = localStorage.getItem("tane_money_family_code");
      if(code) { _familyCode = code; }
    } catch(e) {}

    cloudLoad().then(async d=>{
      const migrated = migrate(d);
      // Firestoreのlogsコレクションからログを追加読み込み
      const firestoreLogs = await loadLogsFromFirestore();
      if(firestoreLogs && firestoreLogs.length > 0) {
        // ローカルログとFirestoreログをマージ（重複排除）
        const localIds = new Set((migrated.logs||[]).map(l=>l.id));
        const newLogs = firestoreLogs.filter(l => !localIds.has(l.id));
        if(newLogs.length > 0) {
          const merged = [...newLogs, ...(migrated.logs||[])];
          merged.sort((a,b) => new Date(b.date) - new Date(a.date));
          migrated.logs = merged;
          console.log(`初回ロード: Firestoreから${newLogs.length}件の追加ログ`);
        }
      }
      setData(migrated);
      setLoading(false);
      // リアルタイム同期開始（configデータ）
      startRealtimeSync((updater)=>{
        setData(prev => {
          const next = typeof updater === 'function' ? updater(prev) : updater;
          return next;
        });
      });
      // ログのリアルタイム同期開始（ログデータ）
      startLogsRealtimeSync(setData);
      // 5秒ごとにFirestoreから最新ログを取得（確実な同期）
      const pollTimer = setInterval(async()=>{
        const firestoreLogs = await loadLogsFromFirestore();
        if(!firestoreLogs || firestoreLogs.length===0) return;
        setData(prev=>{
          if(!prev) return prev;
          const existingIds = new Set((prev.logs||[]).map(l=>l.id));
          const added = firestoreLogs.filter(l=>!existingIds.has(l.id));
          if(added.length===0) return prev;
          const merged = [...added,...(prev.logs||[])];
          merged.sort((a,b)=>new Date(b.date)-new Date(a.date));
          return {...prev, logs: merged};
        });
      }, 5000);
      return ()=>clearInterval(pollTimer);
    }).catch(()=>{
      setData({...INIT});
      setLoading(false);
    });
  },[]);

  // Save to cloud whenever data changes
  useEffect(()=>{
    if (!data) return;
    setSyncSt("saving");
    cloudSave(data)
      .then(()=>setSyncSt("saved"))
      .catch(()=>setSyncSt("error"));
  },[data]);

  const update = useCallback(fn => setData(prev => {
    if(!prev) return prev;
    const next = fn(prev);
    if(!next.logs||next.logs.length<(prev.logs||[]).length-2) next.logs=prev.logs;
    if(!next.expenses||next.expenses.length<(prev.expenses||[]).length-2) next.expenses=prev.expenses;
    return next;
  }),[]);
  const [forcePin,setForcePin]=useState(null);

  if(forcePin){
    return(
      <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:28}}>
        <div style={{fontSize:60,marginBottom:12}}>{forcePin.emoji}</div>
        <h2 style={{fontWeight:900,fontSize:20,color:TEXT,margin:"0 0 8px",textAlign:"center"}}>はじめての暗証番号設定</h2>
        <p style={{color:MUTED,fontSize:13,textAlign:"center",maxWidth:280,lineHeight:1.7,margin:"0 0 24px"}}>
          {forcePin.name}さん初回です！<br/>自分だけの4けたの暗証番号を設定してね。
        </p>
        <PinInput onDone={newPin=>{
          update(d=>({...d,
            children:d.children.map(c=>c.id===forcePin.id?{...c,pin:newPin}:c),
            pinChanged:{...(d.pinChanged||{}),[forcePin.id]:true}
          }));
          setForcePin(null);
          setScreen(forcePin.targetScreen||"child");
        }}/>
      </div>
    );
  }
    if (loading) return (
    <div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      <div style={{textAlign:"center"}}>
        <div style={{animation:"sp .6s linear infinite",display:"inline-block"}}><img src={TANE_ICON} style={{width:52,height:52,objectFit:"cover",borderRadius:14}}/></div>
        <p style={{color:MUTED,fontWeight:700,marginTop:12}}>データを読み込み中…</p>
      </div>
      <style>{`@keyframes sp{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // 新規ファミリー：ファミリーコード未設定ならウィザードを表示
  if (!loading && !getFamilyCode() && !data?.setupComplete) {
    return (
      <ErrorBoundary>
        <SetupWizard data={data} update={update} onComplete={()=>setScreen("home")}/>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    <>
      {/* Sync indicator - 左下に移動して設定ボタンと重ならないようにする */}
      <div style={{position:"fixed",bottom:12,left:12,zIndex:9000,pointerEvents:"none"}}>
        <SyncBadge status={syncSt}/>
      </div>

      {screen==="home" && (
        <HomeScreen data={data} update={update}
          onChild={child=>{
            setActiveChild(child);
            // PINなし設定の場合は直接画面へ
            if((data.noPinIds||{})[child.id]){
              setScreen("child");
              return;
            }
            if(!(data.lockEnabled&&data.lockEnabled[child.id])){
              if(!(data.pinChanged&&data.pinChanged[child.id])){
                setForcePin({id:child.id,name:child.name,emoji:child.emoji,targetScreen:"child"});
              } else if(!(data.tutorialSeen||{})[child.id]) {
                setScreen("tutorial-child");
              } else {
                setScreen("child");
              }
            } else {
              setScreen("pin-child");
            }
          }}
          onParent={()=>setScreen("pin-parent")}
          onParentCard={parent=>{
            setActiveChild(parent);
            if((data.noPinIds||{})[parent.id]){
              setScreen("child");
              return;
            }
            setScreen("pin-child");
          }}
        />
      )}
      {screen==="tutorial-child" && activeChild && (
        <Tutorial
          isParent={false}
          name={activeChild.name}
          emoji={activeChild.emoji}
          onDone={()=>{ setScreen("child"); }}
          onBonus={()=>{
            update(d=>({
              ...d,
              tutorialSeen:{...(d.tutorialSeen||{}),[activeChild.id]:true},
              logs:(()=>{const _e={id:uid(),cid:activeChild.id,type:"grant",label:"🎉 チュートリアル完了ボーナス！",pts:100,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})(),
            }));
          }}
        />
      )}
      {screen==="tutorial-parent" && (
        <Tutorial
          isParent={true}
          name="おや管理"
          emoji="🔐"
          onDone={()=>{
            update(d=>({...d, tutorialSeen:{...(d.tutorialSeen||{}),"parent":true}}));
            setScreen("parent");
          }}
        />
      )}
      {screen==="pin-child" && activeChild && (
        <PinPad title={`${activeChild.name}のPIN`} emoji={activeChild.emoji} hint="4けたの暗証番号を入力してね"
          check={p=>{
            // 子どものPINまたは親のPINをチェック
            const isChild = data.children.some(c=>c.id===activeChild.id);
            const isParent = (data.parents||[]).some(p=>p.id===activeChild.id);
            if(isChild) return p===activeChild.pin;
            if(isParent) return p===activeChild.pin;
            return false;
          }}
          onOk={()=>{
            if(!(data.tutorialSeen||{})[activeChild.id]){
              setScreen("tutorial-child");
            } else {
              setScreen("child");
            }
          }}
          onBack={()=>setScreen("home")}/>
      )}
      {screen==="pin-parent" && (
        <PinPad title="おや管理画面" emoji="🔐" hint="4けたの暗証番号を入力（初期：0000）" check={p=>p===data.parentPin}
          onOk={()=>{
            if(!(data.tutorialSeen||{})["parent"]){
              setScreen("tutorial-parent");
            } else {
              setScreen("parent");
            }
          }}
          onBack={()=>setScreen("home")}
          extra={<button onClick={()=>setScreen("pin-reset")} style={{background:"none",border:"none",color:B,fontSize:13,cursor:"pointer",fontFamily:F,fontWeight:700}}>🔑 PINを忘れた場合はこちら</button>}
        />
      )}
      {screen==="child" && activeChild && (
        <ChildScreen child={data.children.find(c=>c.id===activeChild.id)||activeChild} data={data} update={update} onBack={()=>setScreen("home")} onFamily={()=>setScreen("family_public")}/>
      )}
      {screen==="parent" && activeChild && (
        <ChildScreen child={activeChild} data={data} update={update} onBack={()=>setScreen("home")} onFamily={()=>setScreen("family_guardian")}/>
      )}
      {screen==="parent" && !activeChild && (
        <ChildScreen child={(data.parents||[])[0]||{id:"p1",name:"パパ",emoji:"👨",pin:"3333",ageMode:"senior"}} data={data} update={update} onBack={()=>setScreen("home")} onFamily={()=>setScreen("family_guardian")}/>
      )}
      {screen==="family_public" && (
        <FamilyPublicScreen data={data} viewerRole={activeChild?.role||"child"} onBack={()=>setScreen(activeChild?.role==="parent"?"parent":"child")}/>
      )}
      {screen==="family_guardian" && (
        <FamilyGuardianScreen data={data} onBack={()=>setScreen("parent")} onPublicView={()=>setScreen("family_public")}/>
      )}
      {screen==="pin-reset" && (
        <PinResetScreen data={data} update={update} onBack={()=>setScreen("home")}/>
      )}
    </>
    </ErrorBoundary>
  );
}
