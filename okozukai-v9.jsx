import React, { useState, useEffect, useCallback, useRef } from "react";

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
// ── データ消失の防止ガード ──
// クラウド保存(Firestore)はデバウンス＋fire-and-forgetなので、失敗が画面に出ない。
// 実際の書き込み成否とドキュメントサイズを1か所に集約し、UIに通知する。
// near=サイズが上限(1MB)に接近 / fail=連続して書き込み失敗(変更は端末ローカルには残る)
const SAVE_BYTE_WARN = 820000;          // 約820KBで警告(900KBの安全弁の手前)
let _saveHealth = {ok:true, near:false, bytes:0, failStreak:0};
let _saveHealthCb = null;
function setSaveHealthCb(cb){ _saveHealthCb=cb; if(cb) cb(_saveHealth); }
function reportSaveHealth(patch){ _saveHealth={..._saveHealth,...patch}; if(_saveHealthCb) _saveHealthCb(_saveHealth); }
function byteLen(str){ try{ return (typeof Blob!=="undefined")?new Blob([str]).size:Math.round((str||"").length*1.4); }catch(e){ return (str||"").length; } }
const _processedApprovalIds=new Set(); // 承認/却下済みIDをセッション中保持（同期で復活を防ぐ）
let _familyCode=null; // ファミリーコードのキャッシュ

// 匿名認証（Firestoreルールの前提）。Auth未有効・オフラインでも従来動作を維持（fail-safe）
let _authTried=false;
function ensureAuth(){
  try{
    if(typeof firebase==="undefined"||!firebase.auth)return;
    if(_authTried)return; _authTried=true;
    const a=firebase.auth();
    if(!a.currentUser)a.signInAnonymously().catch(()=>{_authTried=false;});
  }catch(e){}
}

function getDB(){
  if(_db)return _db;
  try{
    if(typeof firebase==="undefined"||!firebase.firestore)return null; // 遅延ロード中
    if(!_fbInit){try{firebase.app();}catch(e){firebase.initializeApp(FIREBASE_CONFIG);}_fbInit=true;}
    ensureAuth();
    _db=firebase.firestore();return _db;
  }catch(e){return null;}
}

// Firebase(遅延ロード)の準備完了を待つ。準備済みなら即時、未ロードなら最大10秒ポーリング。
function whenFirebaseReady(cb){
  if(typeof firebase!=="undefined"&&firebase.firestore){cb();return;}
  let tries=0;
  const t=setInterval(()=>{
    if(typeof firebase!=="undefined"&&firebase.firestore){clearInterval(t);cb();}
    else if(++tries>100){clearInterval(t);cb();} // 10秒で諦め(ローカル表示は維持済み)
  },100);
}

function getFamilyCode(){
  if(_familyCode)return _familyCode;
  try{_familyCode=localStorage.getItem(FAMILY_CODE_KEY);}catch(e){}
  return _familyCode;
}

// ═══ PIN保護（SHA-256ハッシュ化。Firestoreに平文PINを保存しない）═══
// 同期版SHA-256（PinPadのcheckが同期APIのため）。定数は素数から実行時導出（転記ミス防止）
const _SHA=(()=>{
  const P=[];for(let n=2;P.length<64;n++){let ok=true;for(let i=0;i<P.length&&P[i]*P[i]<=n;i++)if(n%P[i]===0){ok=false;break;}if(ok)P.push(n);}
  const frac=(x)=>Math.floor((x-Math.floor(x))*4294967296)>>>0;
  return {K:P.map(p=>frac(Math.cbrt(p))),H0:P.slice(0,8).map(p=>frac(Math.sqrt(p)))};
})();
function sha256Hex(str){
  const rotr=(x,n)=>((x>>>n)|(x<<(32-n)))>>>0;
  const bytes=[];for(let i=0;i<str.length;i++){let c=str.codePointAt(i);if(c>0xFFFF)i++;
    if(c<0x80)bytes.push(c);
    else if(c<0x800)bytes.push(0xC0|(c>>6),0x80|(c&63));
    else if(c<0x10000)bytes.push(0xE0|(c>>12),0x80|((c>>6)&63),0x80|(c&63));
    else bytes.push(0xF0|(c>>18),0x80|((c>>12)&63),0x80|((c>>6)&63),0x80|(c&63));}
  const bitLen=bytes.length*8;
  bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);
  const hi=Math.floor(bitLen/4294967296)>>>0,lo=bitLen>>>0;
  bytes.push((hi>>>24)&255,(hi>>>16)&255,(hi>>>8)&255,hi&255,(lo>>>24)&255,(lo>>>16)&255,(lo>>>8)&255,lo&255);
  const H=_SHA.H0.slice(),K=_SHA.K,W=new Array(64);
  for(let off=0;off<bytes.length;off+=64){
    for(let t=0;t<16;t++)W[t]=((bytes[off+t*4]<<24)|(bytes[off+t*4+1]<<16)|(bytes[off+t*4+2]<<8)|bytes[off+t*4+3])>>>0;
    for(let t=16;t<64;t++){
      const s0=rotr(W[t-15],7)^rotr(W[t-15],18)^(W[t-15]>>>3);
      const s1=rotr(W[t-2],17)^rotr(W[t-2],19)^(W[t-2]>>>10);
      W[t]=(W[t-16]+s0+W[t-7]+s1)>>>0;
    }
    let[a,b,c,d2,e,f,g,h]=H;
    for(let t=0;t<64;t++){
      const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^(~e&g);
      const t1=(h+S1+ch+K[t]+W[t])>>>0;
      const S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)>>>0;
      h=g;g=f;f=e;e=(d2+t1)>>>0;d2=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d2)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  return H.map(x=>x.toString(16).padStart(8,"0")).join("");
}
const PIN_SALT="tane-money:pin:v1:";
function pinHash(p){ return sha256Hex(PIN_SALT+String(p)); }
// メンバーのPIN照合。pinh(ハッシュ)優先、旧形式の平文pinにもフォールバック（移行期間の互換）
function pinMatches(input,member){
  if(!member)return false;
  if(member.pinh)return pinHash(input)===member.pinh;
  return String(input)===String(member.pin||"");
}
function parentPinMatches(input,data){
  if(data&&data.parentPinH)return pinHash(input)===data.parentPinH;
  return String(input)===String((data&&data.parentPin)||"0000");
}
// 親PINが初期値(0000)のままか（変更促しバッジ用）
function parentPinIsDefault(data){
  if(data&&data.parentPinH)return data.parentPinH===pinHash("0000");
  return ((data&&data.parentPin)||"0000")==="0000";
}

let _cloudSaveTimer=null, _cloudSavePending=null;
// data変更のたびに呼ばれるが、重い同期処理(JSON.stringify＋localStorage＋Firestore準備)を
// 約300msデバウンスして、タップ直後の再描画をブロックしない(肥大データでのフリーズ防止)。
async function cloudSave(d) {
  _cloudSavePending = d;
  if(_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
  _cloudSaveTimer = setTimeout(()=>{ const dd=_cloudSavePending; _cloudSavePending=null; if(dd) _cloudPersist(dd); }, 300);
}
function _cloudPersist(d) {
  const code = getFamilyCode()||"default";
  // ログ肥大の抑制: 2000件を超えたら古い分を「くりこし」1行(cidごと)に集約して保存する。
  // 残高は保持(合計を引き継ぐ)。直近1800件は表示用に残し、全ログはlogsサブコレクションに恒久保存。
  // これで localStorage / Firestoreドキュメント / メモリ(再読込後) のサイズを小さく保てる。
  let saveD = d;
  if((d.logs||[]).length > 2000){
    const keep = d.logs.slice(0,1800);
    const sums = {};
    d.logs.slice(1800).forEach(l=>{ if(l&&l.cid!=null) sums[l.cid]=(sums[l.cid]||0)+(l.pts||0); });
    const oldestDate = d.logs[d.logs.length-1]?.date || new Date().toISOString();
    const carry = Object.entries(sums).map(([cid,pts])=>({
      id:"carry_"+cid, cid, type:"grant", label:"くりこし（これより前の合計）", pts, date:oldestDate
    }));
    saveD = {...d, logs:[...keep, ...carry]};
  }
  const json = JSON.stringify(saveD);
  // 1. コード固有のローカルストレージ（他コードと分離）
  try { localStorage.setItem(LOCAL_KEY+"_"+code, json); } catch(e) {}
  try { localStorage.setItem(LOCAL_KEY2+"_"+code, json); } catch(e) {}
  // 2. Firestore（デバウンス・家族間リアルタイム同期）。同じ圧縮済みを保存
  _pendingSave = json;
  // ドキュメントサイズを監視（1MB上限の手前で親に警告を出す）
  const near = byteLen(json) > SAVE_BYTE_WARN;
  reportSaveHealth({near, bytes:byteLen(json)});
  if(_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async()=>{
    if(!code||code==="default"){ reportSaveHealth({ok:true, failStreak:0}); return; }
    const db = getDB();
    if(!db){ reportSaveHealth({ok:true, failStreak:0}); return; }
    try{
      const ts = new Date().toISOString();
      await db.collection("families").doc(code).set({data:_pendingSave,updatedAt:ts});
      _lastSyncTime = ts;  // 書き込み成功後にセット＝失敗時に自己スナップショット除外が誤動作しない
      reportSaveHealth({ok:true, failStreak:0});
    }catch(e){
      console.warn("Firestore save failed:",e);
      // 2回連続で失敗したら警告（一時的なネット瞬断で過剰に出さない）
      reportSaveHealth({failStreak:_saveHealth.failStreak+1, ok:_saveHealth.failStreak+1<2});
    }
  },1000); // 1秒デバウンス（目標・設定変更が素早く保存される）
  // 3. Claude.ai内ならwindow.storageにも保存
  if (hasCloudStorage()) {
    try { window.storage.set(CLOUD_KEY, json); } catch(e) {}
  }
}
// アプリが閉じる/バックグラウンドに入るときは、デバウンス待ちの保存を確実に実行(取りこぼし防止)
function flushCloudSave(){ if(_cloudSaveTimer){clearTimeout(_cloudSaveTimer);_cloudSaveTimer=null;} const dd=_cloudSavePending; _cloudSavePending=null; if(dd) _cloudPersist(dd); }
if(typeof window!=="undefined"){
  window.addEventListener("pagehide", flushCloudSave);
  window.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="hidden") flushCloudSave(); });
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

// ローカル即時ロード（同期・ネット往復なし）＝起動時の初回描画用。
// cloudLoad()のstep2,3と同じローカル参照を、awaitせず即返す。
function localLoadSync() {
  const code = getFamilyCode();
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
  if(!code||code==="TANE-YUTA"){
    try{
      const old=localStorage.getItem(LOCAL_KEY);
      if(old){const p=JSON.parse(old);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
  }
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
            // お手伝い項目(タスク定義)は端末間ユニオン＝追加した項目が消えない(id衝突はローカル編集優先)。
            // ※以前はマージ対象外でサーバ値に上書きされ、別端末/遅延スナップショットで新規項目が消えるバグがあった
            {
              const _uni=(a,b)=>{const m={};[...(a||[]),...(b||[])].forEach(t=>{if(t&&t.id!=null)m[t.id]=t;});return Object.values(m);};
              if(prev.goodTasks) merged.goodTasks=_uni(merged.goodTasks, prev.goodTasks);
              if(prev.badTasks)  merged.badTasks =_uni(merged.badTasks,  prev.badTasks);
            }
            if(prev.myTaskIds) merged.myTaskIds={...(merged.myTaskIds||{}),...prev.myTaskIds};
            if(prev.dailyTaskSets&&prev.dailyTaskSets.length>0) merged.dailyTaskSets=prev.dailyTaskSets;
            if(prev.dailyTasks&&prev.dailyTasks.length>0) merged.dailyTasks=prev.dailyTasks;
            if(prev.activeSetId!==undefined) merged.activeSetId=prev.activeSetId;
            merged.logs=prev.logs; // logsはlogsリアルタイム同期で別管理
            // リアルタイム取得系（ローカル優先）
            if(prev.stocks&&prev.stocks.length>0) merged.stocks=prev.stocks;
            if(prev.forex&&Object.keys(prev.forex).length>0) merged.forex=prev.forex;
            // ゲーム進行系（ローカル優先）
            // ※ gachaDateをここで守らないとFirestoreの遅延snaphotで1日1回制限が崩れる
            if(prev.gachaDate){merged.gachaDate={...(merged.gachaDate||{})};const _td=todayKey();Object.keys(prev.gachaDate).forEach(cid=>{if(prev.gachaDate[cid]===_td)merged.gachaDate[cid]=_td;});}
            // 利子/配当の付与記録: 進んでいる方(最新)を採用＝同期巻き戻しによる二重付与を防止
            if(prev.interestLastDate){merged.interestLastDate={...(merged.interestLastDate||{})};Object.keys(prev.interestLastDate).forEach(cid=>{const p=prev.interestLastDate[cid],m=merged.interestLastDate[cid];const pt=p?new Date(String(p).replace(/-/g,'/')).getTime():0;const mt=m?new Date(String(m).replace(/-/g,'/')).getTime():0;if(pt>mt)merged.interestLastDate[cid]=p;});}
            if(prev.holdBonusLastDate){merged.holdBonusLastDate={...(merged.holdBonusLastDate||{})};Object.keys(prev.holdBonusLastDate).forEach(cid=>{if((prev.holdBonusLastDate[cid]||0)>(merged.holdBonusLastDate[cid]||0))merged.holdBonusLastDate[cid]=prev.holdBonusLastDate[cid];});}
            // 相棒選択(ヤミノオウ/タネモン)はローカル優先＝同期で勝手に戻らない
            if(prev.activePartner) merged.activePartner={...(merged.activePartner||{}),...prev.activePartner};
            // 1日のバトル回数: 今日の分は多い方を採用＝同期巻き戻しで上限を超えられないように
            if(prev.battleCountDay){merged.battleCountDay={...(merged.battleCountDay||{})};const _td=todayKey();Object.keys(prev.battleCountDay).forEach(cid=>{const p=prev.battleCountDay[cid]||{},m=merged.battleCountDay[cid]||{};const pT=p.date===_td,mT=m.date===_td;if(pT&&mT)merged.battleCountDay[cid]={date:_td,n:Math.max(p.n||0,m.n||0)};else if(pT)merged.battleCountDay[cid]=p;else if(!mT)merged.battleCountDay[cid]=p;});}
            if(prev.streak) merged.streak=prev.streak;
            if(prev.dailyProgress) merged.dailyProgress=prev.dailyProgress;
            // モンスター進化/やり直し/転生：最終更新時刻(monsterStageAt)が新しい方を優先＝巻き戻り防止。
            // 段階では判定しない(系統を壊さない)。卵に戻す操作も新しければ保持される。
            {
              merged.monsterEvolved={...(merged.monsterEvolved||{})};
              merged.monsterEvolvedAt={...(merged.monsterEvolvedAt||{})};
              merged.monsterStageAt={...(merged.monsterStageAt||{})};
              merged.monsterIV={...(merged.monsterIV||{})};
              const _t=(o,cid)=>{const v=(o||{})[cid];return v?new Date(v).getTime():0;};
              const cids=new Set([...Object.keys(prev.monsterEvolved||{}),...Object.keys(merged.monsterEvolved||{}),...Object.keys(prev.monsterStageAt||{}),...Object.keys(merged.monsterStageAt||{})]);
              cids.forEach(cid=>{
                const pt=Math.max(_t(prev.monsterStageAt,cid),_t(prev.monsterEvolvedAt,cid));
                const mt=Math.max(_t(merged.monsterStageAt,cid),_t(merged.monsterEvolvedAt,cid));
                if(pt>=mt){ // ローカルが同じか新しい→ローカルを保持(リモートの古い状態で上書きしない)
                  if((prev.monsterEvolved||{})[cid]!==undefined) merged.monsterEvolved[cid]=prev.monsterEvolved[cid];
                  if((prev.monsterEvolvedAt||{})[cid]!==undefined) merged.monsterEvolvedAt[cid]=prev.monsterEvolvedAt[cid];
                  if((prev.monsterStageAt||{})[cid]!==undefined) merged.monsterStageAt[cid]=prev.monsterStageAt[cid];
                  if((prev.monsterIV||{})[cid]!==undefined) merged.monsterIV[cid]=prev.monsterIV[cid];
                }
              });
            }
            // 図鑑(発見済み)は和集合で減らさない
            if(prev.monsterDiscovered){
              merged.monsterDiscovered={...(merged.monsterDiscovered||{})};
              Object.keys(prev.monsterDiscovered).forEach(cid=>{
                merged.monsterDiscovered[cid]=[...new Set([...(merged.monsterDiscovered[cid]||[]),...(prev.monsterDiscovered[cid]||[])])];
              });
            }
            // なでなで(お世話)・転生回数は多い方
            if(prev.monsterCare){merged.monsterCare={...(merged.monsterCare||{})};Object.keys(prev.monsterCare).forEach(cid=>{const pc=prev.monsterCare[cid]||{},rc=merged.monsterCare[cid]||{};if((pc.days||0)>=(rc.days||0))merged.monsterCare[cid]=pc;});}
            if(prev.reincarnationCount){merged.reincarnationCount={...(merged.reincarnationCount||{})};Object.keys(prev.reincarnationCount).forEach(cid=>{merged.reincarnationCount[cid]=Math.max(prev.reincarnationCount[cid]||0,merged.reincarnationCount[cid]||0);});}
            // つけた名前(ニックネーム)・スキン装備も保護（巻き戻り防止）
            if(prev.monsterNickname) merged.monsterNickname={...(merged.monsterNickname||{}),...prev.monsterNickname};
            if(prev.monsterSkin) merged.monsterSkin={...(merged.monsterSkin||{}),...prev.monsterSkin};
            // まめちしきクイズの正解履歴は端末間でユニオン(消えない)
            if(prev.tipsQuiz){merged.tipsQuiz={...(merged.tipsQuiz||{})};Object.keys(prev.tipsQuiz).forEach(cid=>{merged.tipsQuiz[cid]=Array.from(new Set([...(merged.tipsQuiz[cid]||[]),...(prev.tipsQuiz[cid]||[])]));});}
            if(prev.enemyDex){merged.enemyDex={...(merged.enemyDex||{})};Object.keys(prev.enemyDex).forEach(cid=>{merged.enemyDex[cid]=Array.from(new Set([...(merged.enemyDex[cid]||[]),...(prev.enemyDex[cid]||[])]));});}
            // バトル/育成の進行(EXP・チケットは多い方、HP/ボス解放はローカル優先)
            if(prev.monsterExp){merged.monsterExp={...(merged.monsterExp||{})};Object.keys(prev.monsterExp).forEach(cid=>{merged.monsterExp[cid]=Math.max(prev.monsterExp[cid]||0,merged.monsterExp[cid]||0);});}
            if(prev.reincPower){merged.reincPower={...(merged.reincPower||{})};Object.keys(prev.reincPower).forEach(cid=>{merged.reincPower[cid]=Math.max(prev.reincPower[cid]||0,merged.reincPower[cid]||0);});}
            if(prev.monsterLevelSeen){merged.monsterLevelSeen={...(merged.monsterLevelSeen||{})};Object.keys(prev.monsterLevelSeen).forEach(cid=>{merged.monsterLevelSeen[cid]=Math.max(prev.monsterLevelSeen[cid]||0,merged.monsterLevelSeen[cid]||0);});}
            if(prev.battleTickets){merged.battleTickets={...(merged.battleTickets||{})};Object.keys(prev.battleTickets).forEach(cid=>{merged.battleTickets[cid]=Math.max(prev.battleTickets[cid]||0,merged.battleTickets[cid]||0);});}
            if(prev.battleFragments){merged.battleFragments={...(merged.battleFragments||{})};Object.keys(prev.battleFragments).forEach(cid=>{merged.battleFragments[cid]=Math.max(prev.battleFragments[cid]||0,merged.battleFragments[cid]||0);});}
            if(prev.battleFragDate) merged.battleFragDate={...(merged.battleFragDate||{}),...prev.battleFragDate};
            if(prev.battleFragOpps) merged.battleFragOpps={...(merged.battleFragOpps||{}),...prev.battleFragOpps};
            if(prev.battleWins){merged.battleWins={...(merged.battleWins||{})};Object.keys(prev.battleWins).forEach(cid=>{merged.battleWins[cid]=Math.max(prev.battleWins[cid]||0,merged.battleWins[cid]||0);});}
            if(prev.monsterEquip) merged.monsterEquip={...(merged.monsterEquip||{}),...prev.monsterEquip};
            if(prev.healPotions){merged.healPotions={...(merged.healPotions||{})};Object.keys(prev.healPotions).forEach(cid=>{merged.healPotions[cid]=Math.max(prev.healPotions[cid]||0,merged.healPotions[cid]||0);});}
            if(prev.healCaps){merged.healCaps={...(merged.healCaps||{})};Object.keys(prev.healCaps).forEach(cid=>{const p=prev.healCaps[cid]||{},m=merged.healCaps[cid]||{};merged.healCaps[cid]={hs:Math.max(p.hs||0,m.hs||0),hm:Math.max(p.hm||0,m.hm||0)};});}
            if(prev.equipUnlock){merged.equipUnlock={...(merged.equipUnlock||{})};Object.keys(prev.equipUnlock).forEach(cid=>{merged.equipUnlock[cid]=[...new Set([...(merged.equipUnlock[cid]||[]),...(prev.equipUnlock[cid]||[])])];});}
            if(prev.missionClaimed) merged.missionClaimed={...(merged.missionClaimed||{}),...prev.missionClaimed};
            if(prev.expedition) merged.expedition={...(merged.expedition||{}),...prev.expedition};
            // taskExpDay: 同じ日なら使用量(amt)は多い方＝同期巻き戻しでEXP日次上限がリセットされるのを防ぐ
            if(prev.taskExpDay){merged.taskExpDay={...(merged.taskExpDay||{})};Object.keys(prev.taskExpDay).forEach(cid=>{const p=prev.taskExpDay[cid]||{},m=merged.taskExpDay[cid]||{};merged.taskExpDay[cid]=(p.date===m.date)?{date:p.date,amt:Math.max(p.amt||0,m.amt||0)}:p;});}
            if(prev.monsterHP) merged.monsterHP={...(merged.monsterHP||{}),...prev.monsterHP};
            if(prev.monsterHPDate) merged.monsterHPDate={...(merged.monsterHPDate||{}),...prev.monsterHPDate};
            if(prev.monsterHPTs) merged.monsterHPTs={...(merged.monsterHPTs||{}),...prev.monsterHPTs};
            if(prev.battleWinDate) merged.battleWinDate={...(merged.battleWinDate||{}),...prev.battleWinDate};
            if(prev.battleBossUnlocked) merged.battleBossUnlocked={...(merged.battleBossUnlocked||{}),...prev.battleBossUnlocked};
            // darkEgg(ヤミノオウの卵): お世話度は多い方を採用＝同期巻き戻しで育成が消えない
            if(prev.darkEgg){merged.darkEgg={...(merged.darkEgg||{})};Object.keys(prev.darkEgg).forEach(cid=>{const p=prev.darkEgg[cid]||{},m=merged.darkEgg[cid]||{};merged.darkEgg[cid]=((p.care||0)>=(m.care||0))?p:m;});}
            // ヤミノオウのタマゴ所持フラグ: どちらかがtrueなら保持(同期で消えない)。未育成のみ意味を持つ
            if(prev.yamiEgg){merged.yamiEgg={...(merged.yamiEgg||{})};Object.keys(prev.yamiEgg).forEach(cid=>{if(prev.yamiEgg[cid]) merged.yamiEgg[cid]=true;});}
            // eggDrops(ヤミノタマゴ累積ドロップ=基礎ステ+1%/個): 多い方を採用
            if(prev.eggDrops){merged.eggDrops={...(merged.eggDrops||{})};Object.keys(prev.eggDrops).forEach(cid=>{merged.eggDrops[cid]=Math.max(prev.eggDrops[cid]||0,merged.eggDrops[cid]||0);});}
            // 家族バトル・シーズン: 新しい週(シーズン)を優先、同週はbaseをマージ
            if(prev.battleSeason){ if(!merged.battleSeason || (prev.battleSeason.week||0)>(merged.battleSeason.week||0)) merged.battleSeason=prev.battleSeason; else if((prev.battleSeason.week||0)===(merged.battleSeason.week||0)) merged.battleSeason={...merged.battleSeason, base:{...(prev.battleSeason.base||{}),...(merged.battleSeason.base||{})}, champ:merged.battleSeason.champ||prev.battleSeason.champ}; }
            // pendingApprovals: 承認/却下済みentryをリモートから復活させない
            if(_processedApprovalIds.size>0){
              merged.pendingApprovals=(merged.pendingApprovals||[]).filter(p=>!_processedApprovalIds.has(p.id));
            }
            // 新しいpendingApprovalsがあれば親デバイスで通知
            const _prevIds=new Set((prev.pendingApprovals||[]).map(p=>p.id));
            const _newPending=(merged.pendingApprovals||[]).filter(p=>!_prevIds.has(p.id)&&!_processedApprovalIds.has(p.id));
            if(_newPending.length>0&&(prev.familySettings||{}).approvalNotification&&"Notification"in window&&Notification.permission==="granted"){
              _newPending.forEach(p=>{try{new Notification("承認リクエスト 📬",{body:`${p.taskLabel||"タスク"}（+${p.pts||0}pt）`,icon:"/assets/tab_daily.png"});}catch(e){}});
            }
            return merged;
          });
                  }
      }catch(e){}
    },err=>console.warn("Realtime sync error:",err));
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
                    return {...prev, logs: merged};
        });
      }, err => console.warn("Logs realtime sync error:", err));
      } catch(e) { console.warn("Could not start logs realtime sync:", e); }
}


// ═══════════════════════════════════════════════════════
// MONSTER TREE
// ═══════════════════════════════════════════════════════
const MONSTER_TREE = {
  egg:  { id:"egg", name:"タマゴ", rarity:1, line:"", stage:0, evolveTo:"m01",
          desc:"なにが生まれるかわからない、ふしぎなタマゴ。タッチしてあたためよう。", edu:"" },
  // ── 幼年期（共通）──
  m01:  { id:"m01", name:"ミンタモ", rarity:1, line:"", stage:1, evolveTo:"m02",
          desc:"コインのタネから生まれたばかりの赤ちゃん。げんきにぴょこぴょこ動く。",
          edu:"お金は「ためる」と少しずつ増えていく。小さなタネも、毎日の水やりで大きく育つよ。" },
  m02:  { id:"m02", name:"コロミント", rarity:1, line:"", stage:2, branch:["m03","m07","m11"],
          desc:"葉っぱの芽が出てきた幼年期。これから3つの道のどれかに進化する。",
          edu:"ここで3つの道に分かれるよ。もくひょうを達成すると「まなび」、れんぞく7日で「森」、ちょきん1000で「たから」へ進化！" },
  // ── A系統：自然・森（こつこつ継続で寄る）──
  m03:  { id:"m03", name:"バドゥクン", rarity:2, line:"a", stage:3, evolveTo:"m04",
          branchHint:"まいにちつづけて さいこう7日れんぞくで こっちに進化！",
          desc:"森の若芽をせおったいたずら好き。毎日の小さな積み重ねが大すき。",
          edu:"毎日コツコツ続けることを「習慣」という。少しずつでも毎日ためると、1年で大きな差になる。" },
  m04:  { id:"m04", name:"フロラクン", rarity:3, line:"a", stage:4, evolveTo:"m05",
          desc:"花と緑をまとった成熟期。仲間思いで、まわりを元気にする。",
          edu:"植物は太陽の力で養分をつくる(光合成)。お金も「はたらく」と新しい価値を生み出せる。" },
  m05:  { id:"m05", name:"シダーハート", rarity:4, line:"a", stage:5, evolveTo:"m06",
          desc:"大樹の心をもつ完全体。根を深くはり、どっしりかまえる。",
          edu:"大きな木も、もとは一粒のタネ。今ためているお金が、将来の大きな安心になる。" },
  m06:  { id:"m06", name:"ワールドミント", rarity:5, line:"a", stage:6, evolveTo:null,
          desc:"世界をやどす森の王・究極体。ふれた大地に緑とゆたかさを広げる。",
          edu:"自然はみんなの大切な財産。お金も、人やまわりと分け合うと、もっと大きな力になる。" },
  // ── B系統：竜・歴史（タスク&バッジで強くなると寄る）──
  m07:  { id:"m07", name:"スパイドラ", rarity:2, line:"b", stage:3, evolveTo:"m08",
          branchHint:"ちょきんを 1000までためると こっちに進化！",
          desc:"小さな竜の子。たからものを集めるのが得意で、好奇心おうせい。",
          edu:"大むかし、人は貝や石をお金として使った。やがて金や銀の「硬貨」が生まれた。" },
  m08:  { id:"m08", name:"ギルドレイク", rarity:3, line:"b", stage:4, evolveTo:"m09",
          desc:"黄金にかがやくウロコの成熟期。たからの番人として知られる。",
          edu:"硬貨のふちのギザギザは、けずって金属をぬすむズルを防ぐための昔の工夫。" },
  m09:  { id:"m09", name:"レリックワーム", rarity:4, line:"b", stage:5, evolveTo:"m10",
          desc:"古代の遺産を守る完全体。長い時を生き、歴史をその身に刻む。",
          edu:"紙のお金(紙幣)が広まったのは約1000年前の中国から。重い硬貨より持ち運びが楽になった。" },
  m10:  { id:"m10", name:"クロノドレイク", rarity:5, line:"b", stage:6, evolveTo:null,
          desc:"時をあやつる究極の竜。過去と未来をつなぎ、富の流れを見通す。",
          edu:"いまは「電子マネー」で形のないお金も使える時代。お金の形は時代とともに進化する。" },
  // ── C系統：民話・学問（まなび&目標で寄る）──
  m11:  { id:"m11", name:"トーテモル", rarity:2, line:"c", stage:3, evolveTo:"m12",
          branchHint:"もくひょうを 1つたっせいすると こっちに進化！",
          desc:"おまもりを身につけた森の精。ものしりで、なぞなぞが大すき。",
          edu:"世界には「お金のことわざ」がたくさん。『時は金なり』は時間の大切さを教える。" },
  m12:  { id:"m12", name:"スクロベア", rarity:3, line:"c", stage:4, evolveTo:"m13",
          desc:"巻物をかかえた学者グマの成熟期。知ることが何よりの楽しみ。",
          edu:"お金の使い方の計画を「予算(よさん)」という。先に決めておくと、むだづかいが減る。" },
  m13:  { id:"m13", name:"アーキヴル", rarity:4, line:"c", stage:5, evolveTo:"m14",
          desc:"知識の書庫を守るフクロウの完全体。あらゆる知恵を記録する。",
          edu:"お金を貸し借りすると「利子(りし)」がつくことがある。ふやす力にも、借りすぎの注意にもなる。" },
  m14:  { id:"m14", name:"ミスミント", rarity:5, line:"c", stage:6, evolveTo:null,
          desc:"伝説をつむぐ賢者・究極体。学びの力で、人々をゆたかにみちびく。",
          edu:"いちばん大切な財産は「学び」。知識は使ってもへらず、一生きみを助けてくれる。" },
  // ── ヤミノオウ系統(ボス撃破で稀にドロップする卵から育てる。通常タネモンと同じく「育てた度」＋時間で直線進化。gs=gacha_gs_*スプライト) ──
  yami_egg:{ id:"yami_egg", name:"ヤミノタマゴ", rarity:5, line:"yami", stage:0, evolveTo:"yami1", gs:"yamiegg",
          desc:"ヤミノオウが のこした なぞの たまご。あたたかく 育てて 孵そう。",
          edu:"中で 命が 育っている。すぐには かえらない。お金も おなじで、待つ力が 大きく育てる。" },
  yami1:{ id:"yami1", name:"ヤミの雫", rarity:5, line:"yami", stage:1, evolveTo:"yami2", gs:"yami1",
          desc:"殻を やぶって 生まれたばかりの 闇の しずく。まだ ぷるぷる。",
          edu:"どんな 強いものも 始まりは 小さい。お金も コツコツが 力になる。" },
  yami2:{ id:"yami2", name:"ヤミッコ", rarity:5, line:"yami", stage:2, evolveTo:"yami3", gs:"yami2",
          desc:"手足が 生えた 小さな 影。よちよち 動きはじめた。",
          edu:"少しずつ できることが 増えていく。続けるほど 育つのが 育成も 貯金も おなじ。" },
  yami3:{ id:"yami3", name:"ヤミドラゴ", rarity:5, line:"yami", stage:3, evolveTo:"yami4", gs:"yami3",
          desc:"子竜らしく なってきた。小さな ツノと 牙が 生えた。",
          edu:"ここまで 続けられたのが すごい。やめずに 続ける力が、いちばんの 才能だよ。" },
  yami4:{ id:"yami4", name:"ヤミノツバサ", rarity:5, line:"yami", stage:4, evolveTo:"yami5", gs:"yami4",
          desc:"大きな 翼が 生えた 闇の竜。空を かけるように なった。",
          edu:"コツコツの つみ重ねが、目に見える 大きな力に なってきた。投資の 複利と おなじだね。" },
  yami5:{ id:"yami5", name:"ヤミノリュウ", rarity:5, line:"yami", stage:5, evolveTo:"yami_u", gs:"yami5",
          desc:"闇の力が 満ちた 龍。頭上には 光の輪が ともり、王の あと一歩。",
          edu:"あと少し。最後まで やりきる人は そう多くない。ゴールの 目前こそ ふんばりどき。" },
  yami_u:{ id:"yami_u", name:"ヤミノオウ", rarity:5, line:"yami", stage:6, evolveTo:null, gs:"yami",
          desc:"育てて 闇の力を 光に変え、王として めざめた すがた！じぶんだけの ヤミノオウ。",
          edu:"つづける力が いちばん つよい。毎日の 小さな つみ重ねが、伝説の王を 育てあげた。" },
  // ── 猫タネもん：プリン(cpurin) egg→b1→b2→mature→[森の力/星の力]→ult ──
  cpurin_egg:    { id:"cpurin_egg",    name:"プリンのタマゴ", rarity:1, line:"cat", stage:0, evolveTo:"cpurin_b1",
          desc:"鈴のついた、ねこのタマゴ。あたためるとプリンが生まれる。", edu:"いきものを育てるには毎日のお世話が大切。お金も毎日コツコツ育てよう。" },
  cpurin_b1:     { id:"cpurin_b1",     name:"こねこプリン", rarity:1, line:"cat", stage:1, evolveTo:"cpurin_b2",
          desc:"生まれたての、ちいさなプリン。げんきいっぱい。", edu:"小さな一歩のつみ重ねが、大きな成長になるよ。" },
  cpurin_b2:     { id:"cpurin_b2",     name:"わんぱくプリン", rarity:2, line:"cat", stage:2, evolveTo:"cpurin_mature",
          desc:"あそびざかりのプリン。しっぽをふってごきげん。", edu:"毎日つづけると「習慣」になる。続ける力はお金を育てる力。" },
  cpurin_mature: { id:"cpurin_mature", name:"つぶらのプリン", rarity:3, line:"cat", stage:3, branch:["cpurin_perfA","cpurin_perfB"],
          desc:"成熟期のプリン。育て方で2つの道に分かれる。",
          edu:"ここで分岐！れんぞく7日で『森の力』、もくひょう達成で『星の力』へ進化するよ。" },
  cpurin_perfA:  { id:"cpurin_perfA",  name:"森導士プリン", rarity:4, line:"cat", stage:4, evolveTo:"cpurin_ultA",
          branchHint:"まいにちつづけて さいこう7日れんぞくで こっちに進化！",
          desc:"森の力にめざめた完全体。みどりの杖で自然をあやつる。", edu:"自然はみんなの大切な財産。続ける力が大きな実りを生む。" },
  cpurin_perfB:  { id:"cpurin_perfB",  name:"星見導師プリン", rarity:4, line:"cat", stage:4, evolveTo:"cpurin_ultB",
          branchHint:"もくひょうを たっせいすると こっちに進化！",
          desc:"星の力にめざめた完全体。星をよんで未来を見る。", edu:"目標を決めてやりとげる力は、夢をかなえる第一歩。" },
  cpurin_ultA:   { id:"cpurin_ultA",   name:"聖天使プリンエル", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・天使のプリン。光の輪と翼をもつ守り神。", edu:"コツコツ続けた先に、いちばん輝くすがたが待っている。" },
  cpurin_ultB:   { id:"cpurin_ultB",   name:"星界神プリンゾーン", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・星界の神プリン。宇宙の星々をしたがえる。", edu:"目標をかなえ続けた者だけが届く、伝説のすがた。" },
  // ── 猫タネもん：クー(cku) 黒猫 ──
  cku_egg:    { id:"cku_egg",    name:"クーのタマゴ", rarity:1, line:"cat", stage:0, evolveTo:"cku_b1",
          desc:"よるのようにくろい、ねこのタマゴ。", edu:"いきものを育てるには毎日のお世話が大切。お金も毎日コツコツ。" },
  cku_b1:     { id:"cku_b1",     name:"こねこクー", rarity:1, line:"cat", stage:1, evolveTo:"cku_b2",
          desc:"生まれたての黒いこねこ。目がきらきら。", edu:"小さな一歩のつみ重ねが大きな成長に。" },
  cku_b2:     { id:"cku_b2",     name:"わんぱくクー", rarity:2, line:"cat", stage:2, evolveTo:"cku_mature",
          desc:"やんちゃな黒ねこ。よるのおさんぽが大すき。", edu:"毎日つづけると習慣になる。続ける力はお金を育てる力。" },
  cku_mature: { id:"cku_mature", name:"つぶらのクー", rarity:3, line:"cat", stage:3, branch:["cku_perfA","cku_perfB"],
          desc:"成熟期のクー。育て方で2つの道に分かれる。",
          edu:"ここで分岐！れんぞく7日で『森の力』、もくひょう達成で『星の力』へ。" },
  cku_perfA:  { id:"cku_perfA",  name:"森導士クー", rarity:4, line:"cat", stage:4, evolveTo:"cku_ultA",
          branchHint:"まいにちつづけて さいこう7日れんぞくで こっちに進化！",
          desc:"森の力にめざめた完全体のクー。", edu:"続ける力が大きな実りを生む。" },
  cku_perfB:  { id:"cku_perfB",  name:"星見導師クー", rarity:4, line:"cat", stage:4, evolveTo:"cku_ultB",
          branchHint:"もくひょうを たっせいすると こっちに進化！",
          desc:"星の力にめざめた完全体のクー。", edu:"目標をやりとげる力は夢への第一歩。" },
  cku_ultA:   { id:"cku_ultA",   name:"聖天使クーエル", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・天使のクー。", edu:"コツコツ続けた先に、いちばん輝くすがたが待っている。" },
  cku_ultB:   { id:"cku_ultB",   name:"星界神クーゾーン", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・星界の神クー。", edu:"目標をかなえ続けた者だけが届く伝説のすがた。" },
  // ── 猫タネもん：シー(cshi) 白黒猫 ──
  cshi_egg:    { id:"cshi_egg",    name:"シーのタマゴ", rarity:1, line:"cat", stage:0, evolveTo:"cshi_b1",
          desc:"白と黒のもようの、ねこのタマゴ。", edu:"いきものを育てるには毎日のお世話が大切。お金も毎日コツコツ。" },
  cshi_b1:     { id:"cshi_b1",     name:"こねこシー", rarity:1, line:"cat", stage:1, evolveTo:"cshi_b2",
          desc:"生まれたての白黒こねこ。あしあとが大きい。", edu:"小さな一歩のつみ重ねが大きな成長に。" },
  cshi_b2:     { id:"cshi_b2",     name:"わんぱくシー", rarity:2, line:"cat", stage:2, evolveTo:"cshi_mature",
          desc:"げんきな白黒ねこ。とびはねるのが大すき。", edu:"毎日つづけると習慣になる。続ける力はお金を育てる力。" },
  cshi_mature: { id:"cshi_mature", name:"つぶらのシー", rarity:3, line:"cat", stage:3, branch:["cshi_perfA","cshi_perfB"],
          desc:"成熟期のシー。育て方で2つの道に分かれる。",
          edu:"ここで分岐！れんぞく7日で『森の力』、もくひょう達成で『星の力』へ。" },
  cshi_perfA:  { id:"cshi_perfA",  name:"森導士シー", rarity:4, line:"cat", stage:4, evolveTo:"cshi_ultA",
          branchHint:"まいにちつづけて さいこう7日れんぞくで こっちに進化！",
          desc:"森の力にめざめた完全体のシー。剣と盾の騎士。", edu:"続ける力が大きな実りを生む。" },
  cshi_perfB:  { id:"cshi_perfB",  name:"星見導師シー", rarity:4, line:"cat", stage:4, evolveTo:"cshi_ultB",
          branchHint:"もくひょうを たっせいすると こっちに進化！",
          desc:"星の力にめざめた完全体のシー。", edu:"目標をやりとげる力は夢への第一歩。" },
  cshi_ultA:   { id:"cshi_ultA",   name:"聖天使シーエル", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・天使のシー。", edu:"コツコツ続けた先に、いちばん輝くすがたが待っている。" },
  cshi_ultB:   { id:"cshi_ultB",   name:"星界神シーゾーン", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・星界の神シー。", edu:"目標をかなえ続けた者だけが届く伝説のすがた。" },
};

// 6フレームアニメ素材を持つモンスター(IDLE/BOUNCE/WOBBLE等のコマをf0..f5で順送り)
const MON_FRAMES6 = { egg:1, m01:1,m02:1,m03:1,m04:1,m05:1,m06:1,m07:1,m08:1,m09:1,m10:1 };

// ═══════════════════════════════════════════════════════
// 背景テーマ（累計タスク数で解放。暗色なので白文字でも読みやすい）
const BG_THEMES = [
  { id:"auto",   name:"じかんたい", emoji:"🕒", need:0,   grad:null, stars:false },
  { id:"forest", name:"もり",       emoji:"🌲", need:8,   grad:"linear-gradient(180deg,#0a1a12 0%,#0e2b1a 45%,#103a22 100%)", stars:false, img:"/assets/bg_forest.jpg" },
  { id:"ocean",  name:"ふかい海",   emoji:"🌊", need:12,  grad:"linear-gradient(180deg,#04121f 0%,#06283d 40%,#063a4a 75%,#0a4a3a 100%)", stars:false, img:"/assets/bg_ocean.jpg" },
  { id:"sunset", name:"ゆうやけ",   emoji:"🌇", need:25,  grad:"linear-gradient(180deg,#1a0a1e 0%,#5a1530 35%,#a8442a 70%,#3a1a10 100%)", stars:false, img:"/assets/bg_sunset.jpg" },
  { id:"night",  name:"よぞら",     emoji:"🌙", need:45,  grad:"linear-gradient(180deg,#020410 0%,#0a1330 45%,#101a40 100%)", stars:true, img:"/assets/bg_night.jpg" },
  { id:"galaxy", name:"うちゅう",   emoji:"🌌", need:75,  grad:"linear-gradient(180deg,#0a0618 0%,#1a0d33 45%,#0d0820 100%)", stars:true, img:"/assets/bg_galaxy.jpg" },
  { id:"aurora", name:"オーロラ",   emoji:"✨", need:120, grad:"linear-gradient(180deg,#03101a 0%,#06281f 40%,#10103a 80%,#06281f 100%)", stars:true, img:"/assets/bg_aurora.jpg" },
  { id:"sakura", name:"さくら",     emoji:"🌸", need:180, grad:"linear-gradient(180deg,#1a0a16 0%,#4a1a36 40%,#6a2a4a 75%,#2a1020 100%)", stars:true, img:"/assets/bg_sakura.jpg" },
];

// モンスター系統の解放（累計タスクのクリアで新しい仲間が解放される）
const LINE_UNLOCK = { "":0, a:0, b:0, c:0 };

// 隠しモンスター（大きなクリア=累計タスクで解放。すがた(スキン)として装備できる）
// 表示＝解放(need)昇順に並べる(最初に解放される体が先頭に来るように)
// 猫タネもん(うちのこ)シリーズ。卵→ベビー→成熟→完全体(分岐)→究極体(人型)。
// ※モチーフは飼い猫。育てて卒業させ、ランダムに次の猫卵をもらうコレクション用(段階実装)。
const CAT_LINES = [
  { id:"cpurin", name:"プリン", emoji:"🐱",
    stages:[
      { id:"egg",   label:"タマゴ",   rarity:1 },
      { id:"b1",    label:"ベビーI",  rarity:1 },
      { id:"b2",    label:"ベビーII", rarity:2 },
      { id:"mature",label:"つぶらのプリン（成熟期）", rarity:3 },
    ],
    branches:[
      { force:"森の力", color:"#34C77B", stages:[
        { id:"perfA", label:"森導士プリン（完全体）", rarity:4 },
        { id:"ultA",  label:"聖天使プリンエル（究極体）", rarity:5 },
      ]},
      { force:"星の力", color:"#7B61C9", stages:[
        { id:"perfB", label:"星見導師プリン（完全体）", rarity:4 },
        { id:"ultB",  label:"星界神プリンゾーン（究極体）", rarity:5 },
      ]},
    ] },
  { id:"cku", name:"クー", emoji:"🐈⬛",
    stages:[
      { id:"egg",   label:"タマゴ",   rarity:1 },
      { id:"b1",    label:"ベビーI",  rarity:1 },
      { id:"b2",    label:"ベビーII", rarity:2 },
      { id:"mature",label:"つぶらのクー（成熟期）", rarity:3 },
    ],
    branches:[
      { force:"森の力", color:"#34C77B", stages:[
        { id:"perfA", label:"森導士クー（完全体）", rarity:4 },
        { id:"ultA",  label:"聖天使クーエル（究極体）", rarity:5 },
      ]},
      { force:"星の力", color:"#7B61C9", stages:[
        { id:"perfB", label:"星見導師クー（完全体）", rarity:4 },
        { id:"ultB",  label:"星界神クーゾーン（究極体）", rarity:5 },
      ]},
    ] },
  { id:"cshi", name:"シー", emoji:"🐈⬛",
    stages:[
      { id:"egg",   label:"タマゴ",   rarity:1 },
      { id:"b1",    label:"ベビーI",  rarity:1 },
      { id:"b2",    label:"ベビーII", rarity:2 },
      { id:"mature",label:"つぶらのシー（成熟期）", rarity:3 },
    ],
    branches:[
      { force:"森の力", color:"#34C77B", stages:[
        { id:"perfA", label:"森導士シー（完全体）", rarity:4 },
        { id:"ultA",  label:"聖天使シーエル（究極体）", rarity:5 },
      ]},
      { force:"星の力", color:"#7B61C9", stages:[
        { id:"perfB", label:"星見導師シー（完全体）", rarity:4 },
        { id:"ultB",  label:"星界神シーゾーン（究極体）", rarity:5 },
      ]},
    ] },
];

const HIDDEN_MONSTERS = [
  // ── どうぶつの仲間(2コマアニメ・すがたに装備可)。spriteフィールド=gacha_gs_*_a/b.png ──
  { id:"gs_risu", name:"コインリス", rarity:3, need:30, sprite:"risu",
    desc:"コツコツ貯金が大すきなリス。木の実みたいにコインをためる。",
    edu:"リスが木の実をためるように、お金も少しずつコツコツ貯めると、いつのまにか大きく育つ。" },
  { id:"gs_pig",  name:"ブタコ",     rarity:3, need:50, sprite:"pig",
    desc:"おなかにコインをためる、貯金箱のブタ。",
    edu:"貯金箱は『いま使わないお金』をためておく入れもの。少しずつでも、気づけば大きな額になる。" },
  { id:"gs_cat",  name:"まねきネコ", rarity:4, need:70, sprite:"cat",
    desc:"小判をかかげる、えんぎのネコ。",
    edu:"まねきネコは商売はんじょうの縁起もの。でも本当にお金を呼ぶのは、コツコツの努力だよ。" },
  { id:"gs_hari", name:"ハリーくん", rarity:3, need:100, sprite:"hari",
    desc:"ハリに たからをさして だいじにする ハリネズミ。",
    edu:"大事なものは しまっておく。お金も『使う分』と『とっておく分』を分けると安心。" },
  { id:"gs_fox",  name:"きんギツネ", rarity:4, need:130, sprite:"fox",
    desc:"かしこく お金をつかう、金色のキツネ。",
    edu:"同じ100円でも『考えて使う』と価値が大きくなる。安いだけで選ばないのが、かしこい使い方。" },
  { id:"gs_owl",  name:"フクロウ博士", rarity:4, need:160, sprite:"owl",
    desc:"お金の計画をおしえる、もの知り博士。",
    edu:"先に『何にいくら使うか』を決めるのが予算。計画を立てると、ムダづかいが減るよ。" },
  { id:"gs_dragon", name:"たからリュウ", rarity:5, need:210, sprite:"dragon",
    desc:"たからを まもる、みどりの竜。",
    edu:"ためた宝(貯金)は、いざという時の力になる。守る気持ちも大事な『お金の力』。" },
  { id:"gs_lion", name:"こがね獅子", rarity:5, need:260, sprite:"lion",
    desc:"富をまもる、でんせつの黄金獅子。",
    edu:"金(ゴールド)は大むかしから価値が変わりにくい宝物。ねばり強く続けた人に、富はやってくる。" },
  // ── 新収録「黄金の系譜」(お金×成長×自然×伝説×歴史) ＋ 既存隠し ──
  { id:"mameko", name:"マメコ",        rarity:4, need:40,
    desc:"一枚の金貨から生まれた妖精。みんなの貯金が大すき。",
    edu:"コイン(硬貨)は国が価値を保証したお金。重さや、ふちのギザギザ・模様で、本物だと分かるように作られている。" },
  { id:"niji",   name:"ニジドラゴン", rarity:5, need:60,
    desc:"虹色にかがやく伝説の竜。雨上がりの空に現れるという。",
    edu:"虹は太陽の光が空気中の雨つぶで曲がり、7色(赤・橙・黄・緑・青・藍・紫)に分かれて見える現象。だから虹は太陽と反対の空に出る。" },
  { id:"garuda", name:"テンガ・ガルダ", rarity:5, need:90,
    desc:"雷をまとう黄金の神鳥。大空を支配するといわれる。",
    edu:"雷は雲の中の電気が一気に流れる現象。光ってから音(ゴロゴロ)まで時間があるのは、光が音よりずっと速く伝わるから。" },
  { id:"kogane", name:"コガネオウ",   rarity:5, need:120,
    desc:"全身が黄金にかがやく王者。ふれたものを宝に変えるとか。",
    edu:"金(ゴールド)はさびず輝きが長く続くため、昔から世界中でお金や宝物に使われた。とてもやわらかく、わずかな量で大きく延ばせる金属。" },
  { id:"gear",   name:"ギアドレイク",  rarity:5, need:140,
    desc:"体の中の歯車が回り続ける機械竜。とまらない成長の象徴。",
    edu:"歯車を組み合わせると、小さな力で大きな仕事ができる。お金も「複利」で、利子に利子がついて歯車のように増えていく。" },
  { id:"hoshi",  name:"ホシリュウ",   rarity:5, need:200,
    desc:"夜空からまいおりた星の竜。ねがいをかなえるといわれる。",
    edu:"夜空の星のほとんどは太陽のような『恒星』。とても遠いので、今見えている光は何年も前に出たもの。光は1秒で地球を7周半すすむ。" },
  { id:"palad",  name:"ゴルド・パラディン", rarity:5, need:220,
    desc:"黄金のよろいをまとう神の将。紋章は誇りのしるし。",
    edu:"昔の騎士や武将は、盾やはたの『紋章』で自分の家や役わりを示した。紋章はいわば自分だけの印(ロゴ)。" },
  { id:"ogon",   name:"オウゴンリュウ", rarity:5, need:280,
    desc:"全身が黄金にかがやく伝説の竜。富をもたらす王者。",
    edu:"金は世界中で大むかしから、価値が変わりにくい『お金』として使われた。さびず輝きが続くので、宝物や硬貨になった。" },
  // ── 特別: ヤミノオウの卵から育てる(ボス撃破で稀にドロップ)。task数では解放されない(special) ──
  { id:"gs_yami", name:"ヤミノオウ", rarity:5, need:99999, special:"darkEgg", sprite:"yami",
    desc:"お世話で 闇の力を 光に変え、王として めざめた すがた。じぶんだけの ヤミノオウ。",
    edu:"つづける力が いちばん つよい。毎日の 小さな お世話の つみ重ねが、伝説の王を 育てあげた。" },
];

// ── ヤミノオウの卵: ボス撃破で稀にドロップ→お世話で孵化＆育て、7段階(たまご→究極体ヤミノオウ)に進化 ──
// 段階名は既存モンスターと同じデジモン式(幼年期/成長期/成熟期/完全体/究極体)
const DARK_EGG_MAX = 22;  // お世話この回数で究極体ヤミノオウに最終進化(=スキン解放)
const DARK_EGG_STAGES = [
  { min:0,  stage:"たまご",  name:"ヤミノタマゴ",  emoji:"🥚", sprite:"yamiegg",
    desc:"ヤミノオウが のこした なぞの たまご。あたたかく お世話して 孵そう。",
    edu:"中で 命が 育っている。すぐには かえらない。お金も おなじで、待つ力が 大きく育てる。" },
  { min:2,  stage:"幼年期1", name:"ヤミの雫",      emoji:"💧", sprite:"yami1",
    desc:"殻を やぶって 生まれたばかりの 闇の しずく。まだ ぷるぷる。",
    edu:"どんな 強いものも 始まりは 小さい。毎日の お世話を つみ重ねよう。お金も コツコツが 力になる。" },
  { min:5,  stage:"幼年期2", name:"ヤミッコ",      emoji:"🫧", sprite:"yami2",
    desc:"手足が 生えた 小さな 影。よちよち 動きはじめた。",
    edu:"少しずつ できることが 増えていく。続けるほど 育つのが 育成も 貯金も おなじ。" },
  { min:9,  stage:"成長期",  name:"ヤミドラゴ",    emoji:"🐲", sprite:"yami3",
    desc:"子竜らしく なってきた。小さな ツノと 牙が 生えた。",
    edu:"ここまで 続けられたのが すごい。やめずに 続ける力が、いちばんの 才能だよ。" },
  { min:13, stage:"成熟期",  name:"ヤミノツバサ",  emoji:"🦇", sprite:"yami4",
    desc:"大きな 翼が 生えた 闇の竜。空を かけるように なった。",
    edu:"コツコツの つみ重ねが、目に見える 大きな力に なってきた。投資の 複利と おなじだね。" },
  { min:17, stage:"完全体",  name:"ヤミノリュウ",emoji:"🐉", sprite:"yami5",
    desc:"闇の力が 満ちた 龍。頭上には 光の輪が ともり、王の あと一歩。",
    edu:"あと少し。最後まで やりきる人は そう多くない。ゴールの 目前こそ ふんばりどき。" },
  { min:DARK_EGG_MAX, stage:"究極体", name:"ヤミノオウ", emoji:"👑", sprite:"yami",
    desc:"お世話で 闇の力を 光に変え、王として めざめた すがた！じぶんだけの ヤミノオウ。",
    edu:"つづける力が いちばん つよい。毎日の 小さな お世話の つみ重ねが、伝説の王を 育てあげた。" },
];
const darkEggStage = (care)=>{ let s=DARK_EGG_STAGES[0]; for(const st of DARK_EGG_STAGES){ if((care||0)>=st.min) s=st; } return s; };
// 隠しモンスターの解放判定(special=darkEggは卵の育成度、それ以外はタスク累計)
function hiddenUnlocked(h, data, child, totalDone){
  if(h.special==="darkEgg") return (data.monsterDiscovered?.[child.id]||[]).includes("yami_u");   // 究極体ヤミノオウまで育てたら「すがた」解放
  return totalDone >= h.need;
}

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// 進化の状態（時間ゲート＋育てた度ゲージの二重条件）
// EVO_HOURS:  現ステージを「出る」のに必要な最低経過時間(h)。幼年期1=2h,幼年期2=2h,成長期=24〜42h(個体差),成熟期=24h,完全体=72h
// EVO_GROWTH: 現ステージを「出る」のに必要な累計"育てた度"(=お手伝い + バッジ*3 + なでなで日数*2)
const EVO_HOURS  = { 0:2, 1:2, 2:33, 3:24, 4:72, 5:72 };
// 成長期(stage2)だけは24〜42hの個体差(子ごとに決まる)
function evoHoursFor(stage, cid){
  if(stage===2){ let n=0; for(const c of String(cid)) n=(n*31+c.charCodeAt(0))%19; return 24+n; }
  return EVO_HOURS[stage] ?? 0;
}
const EVO_GROWTH = { 0:2, 1:5, 2:9, 3:16, 4:26, 5:40 };
const REINC_HOURS = 96;   // 究極体→転生できるまで(4日)
function getMonState(data, child){
  const cid = child.id;
  const logs = (data.logs||[]).filter(l=>l.cid===cid);
  const tasksDone  = logs.filter(l=>l.type==="good"||l.type==="daily").length;
  const badgeCount = logs.filter(l=>l.type==="badge").length;
  const careDays   = ((data.monsterCare||{})[cid]||{}).days || 0;
  // 配当ごはん: 長期保有の配当(interestログのうち「配当」)を相棒の育てた度に加算(上限30=投資→育成の融合)
  const dividendFeed = Math.min(30, logs.filter(l=>l.type==="interest" && /配当/.test(l.label||"")).length);
  const gauge      = tasksDone + badgeCount*3 + careDays*2 + dividendFeed;   // 育てた度
  const rawId = (data.monsterEvolved||{})[cid] || null;
  const curId = (rawId && MONSTER_TREE[rawId]) ? rawId : "egg";
  const def   = MONSTER_TREE[curId];
  const stage = def.stage||0;
  const isFinal = !def.evolveTo && !def.branch;
  // テスト進化モード(1時間限定): 時間ゲート＆育てた度をスキップして即進化/即卒業できる
  const testEvolve = ((data.testEvolveUntil||{})[cid] || 0) > Date.now();
  const need     = EVO_GROWTH[stage] ?? 0;
  const prevNeed = stage>0 ? (EVO_GROWTH[stage-1] ?? 0) : 0;
  const growthOk = testEvolve ? true : (gauge >= need);
  const growthPct = isFinal ? 100 : Math.max(0, Math.min(100, Math.round((gauge-prevNeed)/Math.max(1,need-prevNeed)*100)));
  const growthRemain = isFinal ? 0 : Math.max(0, need - gauge);
  const stageAt = (data.monsterStageAt||{})[cid] || (data.monsterEvolvedAt||{})[cid] || null;
  const elapsedMs = stageAt ? (Date.now() - new Date(stageAt).getTime()) : Infinity;
  // ヤミノオウの卵を育成中(究極体前)は、通常モンスターの進化が1.5倍遅くなる(育てる力が分散)
  const _eggRaising = false;   // (旧)ヤミノオウ卵の育成中に通常進化を1.5倍遅くする仕様は廃止。今は1体ずつ育てる
  const reqMs = evoHoursFor(stage, cid) * 3600000 * (_eggRaising ? 1.5 : 1);
  const timeOk = testEvolve ? true : (elapsedMs >= reqMs);
  const timeRemainMs = Math.max(0, reqMs - elapsedMs);
  const canEvolve = !isFinal && timeOk && growthOk;
  const reincRemainMs = isFinal ? Math.max(0, REINC_HOURS*3600000 - elapsedMs) : 0;
  const canReincarnate = isFinal && (testEvolve || elapsedMs >= REINC_HOURS*3600000);
  return { curId, def, stage, isFinal, tasksDone, badgeCount, careDays, gauge, need, testEvolve,
           growthOk, growthPct, growthRemain, timeOk, timeRemainMs, canEvolve,
           canReincarnate, reincRemainMs };
}
function fmtTimeRemain(ms){
  if(ms<=0 || !isFinite(ms)) return "";
  const h = Math.ceil(ms/3600000);
  if(h>=24){ const d=Math.ceil(h/24); return `あと${d}日`; }
  return `あと${h}時間`;
}

const INIT = {
  parentPinH: pinHash("0000"),
  children: [
    { id: "c1", name: "れいか", emoji: "🌸", pinh: pinHash("1111"), ageMode: "middle",
      displayMode: "teen", role: "child", gradeLabel: "中学生",
      permissions: { investment: "trade", forex: "trade", dailyBonus: true, ranking: true },
      visibility: { balanceToFamily: "hidden", goalToFamily: "progress_only", investmentResultToFamily: "ranking_only", rankingParticipation: true, operationRankingParticipation: true, rankingMetric: "approved_activity_points" }
    },
    { id: "c2", name: "かなと", emoji: "⚡", pinh: pinHash("2222"), ageMode: "senior",
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
    {id:"g22",emoji:"🛏",label:"家族の布団を整える",pts:30,over:{}},
    {id:"g23",emoji:"🧺",label:"洗濯物をたたむ",pts:30,over:{}},
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
    {id:"g36",emoji:"📝",label:"テストで満点を取る",pts:1000,over:{}},
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
  activeSetId: "set_default",  // 後方互換(単一)
  activeSetIds: ["set_default"],  // 同時アクティブ(最大2)
  dailyProgress: {},
  parents: [
    {id:"p1",name:"パパ",emoji:"👨",pinh:pinHash("3333"),
      displayMode:"adult", role:"parent", gradeLabel:"",
      participationMode:"player_and_guardian",
      permissions:{investment:"trade",forex:"trade",dailyBonus:true,ranking:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"}
    },
    {id:"p2",name:"ママ",emoji:"👩",pinh:pinHash("4444"),
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
  interestRate: 0.01,
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
  tipsQuiz: {},
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
    approvalNotification: false,
    rewardApproval: false,
    gameMode: "full",   // full=全部 / light=バトル・旅オフ / money=お小遣い帳中心(ゲーム要素オフ)
    dailyBattleLimit: 0,   // 1日のバトル回数上限(0=無制限・周回しすぎ防止)
  },
  pendingApprovals: [],
  pendingRedemptions: [],
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
  if(!d.pendingRedemptions) d.pendingRedemptions=[];
  if(!d.familySettings) d.familySettings={...INIT.familySettings};
  if(d.familySettings.requireApproval===undefined) d.familySettings.requireApproval=false;
  if(d.familySettings.approvalNotification===undefined) d.familySettings.approvalNotification=false;
  if(d.familySettings.rewardApproval===undefined) d.familySettings.rewardApproval=false;
  if(!d.familySettings.familyMission) d.familySettings.familyMission={...INIT.familySettings.familyMission};
  if(!d.monsterEvolved) d.monsterEvolved={};
  if(!d.monsterIV) d.monsterIV={};
  if(!d.monsterDiscovered) d.monsterDiscovered={};
  if(!d.monsterEvolvedAt) d.monsterEvolvedAt={};
  if(!d.reincarnationCount) d.reincarnationCount={};
  if(!d.reincarnationBonus) d.reincarnationBonus={};
  if(!d.reincPower) d.reincPower={};
  if(!d.monsterLevelSeen) d.monsterLevelSeen={};
  if(!d.monsterStageAt) d.monsterStageAt={};
  if(!d.monsterCare) d.monsterCare={};
  if(!d.collectedMons) d.collectedMons={};   // うちのこ(卒業した猫)コレクション
  if(!d.yamiEgg) d.yamiEgg={};   // ヤミノオウのタマゴ所持フラグ(未育成)
  // 旧・闇の卵お世話システム(darkEgg)→ ヤミノオウは通常タネモン化。育成度はリセットし、所持者には新タマゴを配る
  if(d.darkEgg){ Object.keys(d.darkEgg).forEach(cid=>{ if(!String((d.monsterEvolved||{})[cid]||"").startsWith("yami")) d.yamiEgg[cid]=true; }); d.darkEgg={}; }
  // 旧モンスター体系(1a/2a1…)の保存値は新ツリーに無いので卵へリセット
  Object.keys(d.monsterEvolved||{}).forEach(cid=>{ if(d.monsterEvolved[cid] && !MONSTER_TREE[d.monsterEvolved[cid]]) d.monsterEvolved[cid]=null; });
  Object.keys(d.monsterDiscovered||{}).forEach(cid=>{ d.monsterDiscovered[cid]=(d.monsterDiscovered[cid]||[]).filter(id=>MONSTER_TREE[id]); });
  // 全子供に egg を図鑑登録（初期値）
  (d.children||[]).forEach(c=>{
    if(!d.monsterDiscovered[c.id]) d.monsterDiscovered[c.id]=["egg"];
    else if(!d.monsterDiscovered[c.id].includes("egg")) d.monsterDiscovered[c.id]=["egg",...d.monsterDiscovered[c.id]];
    // 既に進化済みの場合は進化先も図鑑に追加
    const evo=d.monsterEvolved[c.id];
    if(evo && !d.monsterDiscovered[c.id].includes(evo)) d.monsterDiscovered[c.id]=[...d.monsterDiscovered[c.id],evo];
  });
  if(!d.onboardingChecks) d.onboardingChecks={};
  if(!d.claimedMissions) d.claimedMissions={};
  if(!d.beginnerMissionDone) d.beginnerMissionDone={};
  if(!d.gachaCollection) d.gachaCollection={};
  // 既存メンバーにdisplayMode・permissions・visibilityを後付け（後方互換）
  const defaultChildPerms={investment:"trade",forex:"trade",dailyBonus:true,ranking:true};
  const defaultChildVis={balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"};
  const defaultParentPerms={investment:"trade",forex:"trade",dailyBonus:true,ranking:true};
  const defaultParentVis={balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"};
  d.children=d.children.map(c=>({displayMode:"teen",role:"child",gradeLabel:"",permissions:defaultChildPerms,visibility:defaultChildVis,...c}));
  if(d.parents) d.parents=d.parents.map(p=>({displayMode:"adult",role:"parent",gradeLabel:"",participationMode:"player_and_guardian",permissions:defaultParentPerms,visibility:defaultParentVis,...p}));
  // PIN平文→ハッシュ移行（クラウドに平文PINを残さない。旧データは初回ロード時に自動変換）
  d.children=d.children.map(c=>{ if(c.pin&&!c.pinh){const{pin,...rest}=c;return{...rest,pinh:pinHash(pin)};} return c; });
  if(d.parents) d.parents=d.parents.map(p=>{ if(p.pin&&!p.pinh){const{pin,...rest}=p;return{...rest,pinh:pinHash(pin)};} return p; });
  if(d.parentPin&&!d.parentPinH){ d.parentPinH=pinHash(d.parentPin); delete d.parentPin; }
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
  // 同時アクティブ配列を保証(旧データはactiveSetIdから生成)。存在するセットのみ・最大2件
  if(!Array.isArray(d.activeSetIds)||d.activeSetIds.length===0) d.activeSetIds=[d.activeSetId].filter(Boolean);
  d.activeSetIds=d.activeSetIds.filter(id=>d.dailyTaskSets.some(s=>s.id===id)).slice(0,4);
  if(d.activeSetIds.length===0&&d.dailyTaskSets[0]) d.activeSetIds=[d.dailyTaskSets[0].id];
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
  if(d.interestRate===undefined)     d.interestRate=0.01;
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
  if(!d.tipsQuiz)      d.tipsQuiz={};
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
  // 旧形式(g1/g2)の既定タスクをINITへ移行。ただしユーザー追加分(旧ID以外)は必ず残す
  if(d.goodTasks.length<=4&&d.goodTasks.some(t=>t.id==="g1"||t.id==="g2")){ const _c=d.goodTasks.filter(t=>!/^g\d$/.test(String(t.id))); d.goodTasks=[...INIT.goodTasks,..._c]; }
  if(d.badTasks.length<=3&&d.badTasks.some(t=>t.id==="b1"||t.id==="b2")){   const _c=d.badTasks.filter(t=>!/^b\d$/.test(String(t.id)));  d.badTasks =[...INIT.badTasks,..._c]; }
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
// 期間(startDate/endDate)はtype="date"のゼロ埋め"YYYY-MM-DD"。比較はこちらで揃える(todayKeyはゼロ埋め無しなので文字列比較が壊れる)
const todayISO = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
// 連打/二重実行ガード(モジュール共通)。同じkeyはms以内の2回目を弾く＝お金系操作の二重実行を防止
const _txLocks={};
function txGuard(key, ms=800){ const now=Date.now(); if(_txLocks[key] && now-_txLocks[key]<ms) return false; _txLocks[key]=now; return true; }

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
    return s + Math.floor(pts*0.98); // 売却時2%手数料を考慮
  },0);
  // 為替の損益計算
  const forexBuyCost = logs.filter(l=>l.type==="forex_buy").reduce((s,l)=>s+Math.abs(l.pts),0);
  const forexSellEarn = logs.filter(l=>l.type==="forex_sell").reduce((s,l)=>s+l.pts,0);
  const forexHeld = (data.forexHoldings||{})[memberId]||{};
  const forexData = data.forex||{};
  const forexCurrentValue = Object.entries(forexHeld).reduce((s,[code,amt])=>{
    const fxEntry = Object.values(forexData).find(f=>f.code===code);
    if(!fxEntry||!amt)return s;
    return s + Math.floor(amt*(fxEntry.price||0)*0.995); // 売却時0.5%手数料
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

// 【一時テスト】この時刻まではガチャ回し放題（保存なし＝データを汚さない）。過ぎたら自動で通常の1日1回に戻る
const GACHA_TEST_UNTIL = 1781454600000; // テスト回し放題 〜JST 01:30

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
      <span style={{fontSize:11, color:col[status]||MUTED, fontWeight:700, background:`${col[status]||MUTED}15`, padding:"2px 7px", borderRadius:10}}>{map[status]||status}</span>
      <span style={{fontSize:11, color:MUTED, fontWeight:700, padding:"1px 5px"}}>{code}</span>
    </div>
  );
};

// データ消失の防止ガード：保存失敗 or サイズ上限接近を画面上部に警告（保護者に気づかせる）
const SaveGuardBanner = () => {
  const [h,setH]=useState(null);
  const [closed,setClosed]=useState(false);
  useEffect(()=>{ setSaveHealthCb(setH); return ()=>setSaveHealthCb(null); },[]);
  if(!h) return null;
  const fail=!h.ok, near=h.near;
  if(!fail && !near) return null;
  if(closed && !fail) return null; // 失敗時は閉じても出し続ける（重要）
  const kb=Math.round((h.bytes||0)/1024);
  return (
    <div style={{position:"fixed",top:0,left:0,right:0,zIndex:9500,background:fail?R:GOLD,color:fail?"#fff":TEXT,
      padding:"9px 14px",fontFamily:F,fontSize:12.5,fontWeight:800,textAlign:"center",
      boxShadow:"0 2px 10px rgba(0,0,0,.18)",display:"flex",alignItems:"center",gap:8,justifyContent:"center"}}>
      <span style={{flex:1}}>
        {fail
          ? "⚠ クラウド保存に失敗中。変更はこの端末に残っています。通信環境を確認してください。"
          : `⚠ データ量が上限に近づいています（約${kb}KB）。古い記録は自動でまとめられます。`}
      </span>
      {!fail && <button onClick={()=>setClosed(true)} style={{background:"rgba(0,0,0,.12)",border:"none",borderRadius:8,padding:"3px 9px",fontWeight:800,fontSize:12,color:TEXT,cursor:"pointer",fontFamily:F,flexShrink:0}}>×</button>}
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
      <div style={{marginBottom:6}}><Emo e={emoji} size={52}/></div>
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
  // ── 第0弾「はじめてのタネ図鑑」(setId:s00) 各カードにedu=お金/努力の学び ──
  {id:"gi_n1",tierId:"gc1",setId:"s00",emoji:"🌱",name:"タネっち",  desc:"まいにちのタネ",   edu:"おかねは タネみたい。少しずつ ためると 大きく そだつよ"},
  {id:"gi_n2",tierId:"gc1",setId:"s00",emoji:"🌿",name:"わかば",    desc:"みどりのわかば",   edu:"まいにち コツコツ つづけると ちからが ついてくる"},
  {id:"gi_n3",tierId:"gc1",setId:"s00",emoji:"🍀",name:"よつば",    desc:"しあわせのよつば", edu:"ラッキーも うれしいけど、コツコツが いちばん つよい"},
  {id:"gi_n4",tierId:"gc1",setId:"s00",emoji:"🌾",name:"こむぎ",    desc:"ゆたかなみのり",   edu:"むかしは こくもつが おかねの かわりだった ことも"},
  {id:"gi_n5",tierId:"gc1",setId:"s00",emoji:"🍂",name:"おちば",    desc:"あきのきおく",     edu:"おかねは つかうと へる。たいせつに つかおう"},
  {id:"gi_n6",tierId:"gc1",setId:"s00",emoji:"🌻",name:"ひまわり",  desc:"たいようのちから", edu:"たいようの ように、おかねも はたらくと そだつ"},
  {id:"gi_r1",tierId:"gc2",setId:"s00",emoji:"⭐",name:"スター",     desc:"かがやくほし",     edu:"もくひょうを きめると ゆめに ちかづくよ"},
  {id:"gi_r2",tierId:"gc2",setId:"s00",emoji:"🦋",name:"ちょうちょ",desc:"はねのかがやき",   edu:"コツコツが おおきな へんかに なる(さなぎ→ちょう)"},
  {id:"gi_r3",tierId:"gc2",setId:"s00",emoji:"🐠",name:"さかな",    desc:"うみのたから",     edu:"うみの めぐみも しげん。とりすぎないのが たいせつ"},
  {id:"gi_r4",tierId:"gc2",setId:"s00",emoji:"🌙",name:"みかづき",  desc:"よるのひかり",     edu:"ねている あいだに 利子で おかねが ふえる ことも"},
  {id:"gi_r5",tierId:"gc2",setId:"s00",emoji:"🎵",name:"おんぷ",    desc:"こころのメロディ", edu:"すきな ことに つかうと こころが ゆたかに なる"},
  {id:"gi_r6",tierId:"gc2",setId:"s00",emoji:"🔮",name:"まほうだま",desc:"ふしぎなちから",   edu:"おかねの まほうは『ふくり』。利子に 利子が つく"},
  {id:"gi_sr1",tierId:"gc3",setId:"s00",emoji:"🌈",name:"にじ",     desc:"そらにかかるにじ", edu:"あめの あとに にじ。がまんの あとに ごほうび"},
  {id:"gi_sr2",tierId:"gc3",setId:"s00",emoji:"💎",name:"ダイヤ",   desc:"しんぴのほうせき", edu:"みんなが ほしがるほど ねだんが 上がる=きしょうせい"},
  {id:"gi_sr3",tierId:"gc3",setId:"s00",emoji:"🦄",name:"ユニコーン",desc:"まほうのいきもの",edu:"めずらしい ものは かちが 高い。でも 本当の たからは けいけん"},
  {id:"gi_sr4",tierId:"gc3",setId:"s00",emoji:"🐉",name:"ドラゴン", desc:"でんせつのりゅう", edu:"むかしの ものがたりでは りゅうが たからを まもった"},
  {id:"gi_ur1",tierId:"gc4",setId:"s00",emoji:"👑",name:"おうかん",  desc:"さいこうのしるし", edu:"むかし 王さまが おかねを つくった。いまは くにが かんり"},
  {id:"gi_ur2",tierId:"gc4",setId:"s00",emoji:"🌟",name:"ゴールドスター",desc:"きょくちょうのかがやき",edu:"きんは さびずに かがやく。だから せかいじゅうで たからもの"},
  // ── 第1弾「世界のお金 図鑑」(setId:s01) お金の知識カード ──
  {id:"gm_y1",  tierId:"gc1",setId:"s01",emoji:"🪙",name:"1円玉",  desc:"いちばん かるいコイン", edu:"1円玉は アルミ。とても かるくて 水に うくことも あるよ"},
  {id:"gm_y10", tierId:"gc1",setId:"s01",emoji:"🪙",name:"10円玉", desc:"どうの コイン",       edu:"10円玉は どう(銅)。つかうほど 色が かわっていく"},
  {id:"gm_y100",tierId:"gc1",setId:"s01",emoji:"🪙",name:"100円玉",desc:"ぎざぎざコイン",     edu:"ふちの ギザギザは けずって ズルするのを ふせぐ くふう"},
  {id:"gm_bill",tierId:"gc1",setId:"s01",emoji:"💴",name:"おさつ", desc:"かみのお金",         edu:"おさつは とくべつな かみと インク。にせもの ぼうしの ため"},
  {id:"gm_usd", tierId:"gc2",setId:"s01",emoji:"💵",name:"ドル",   desc:"アメリカのお金",     edu:"ドルは せかいで いちばん つかわれる お金。りょうがえで 円と こうかん"},
  {id:"gm_eur", tierId:"gc2",setId:"s01",emoji:"💶",name:"ユーロ", desc:"ヨーロッパのお金",   edu:"ヨーロッパの たくさんの くにが おなじ ユーロを つかう"},
  {id:"gm_koban",tierId:"gc3",setId:"s01",emoji:"🟡",name:"小判",  desc:"江戸のきんか",       edu:"小判は 江戸じだいの きんか。おさむらいが つかった お金"},
  {id:"gm_oban", tierId:"gc4",setId:"s01",emoji:"🟡",name:"大判",  desc:"でっかいきんか",     edu:"大判は とても 大きな きんか。むかしの さいこうきゅうの お金"},
];

// ═══════════════════════════════════════════════════════
// GACHA ANIMATION
// ═══════════════════════════════════════════════════════
// ドット絵アイコン共通部品(画像が無ければ絵文字fbにフォールバック)
function Ico({name,size=20,fb,style}){
  return <img src={`/assets/icon_${name}.png`} alt="" draggable="false"
    onError={fb?e=>{const s=document.createElement("span");s.textContent=fb;s.style.fontSize=Math.round(size*0.92)+"px";s.style.lineHeight="1";e.target.replaceWith(s);}:e=>{e.target.style.display="none";}}
    style={{width:size,height:size,objectFit:"contain",imageRendering:"pixelated",verticalAlign:"middle",display:"inline-block",...style}}/>;
}

// 絵文字 or ドット絵アイコン(値が "ico:name" ならアイコン画像)を出し分ける共通レンダラ
function Emo({e,size=20,style}){
  if(typeof e==="string" && e.startsWith("ico:")) return <Ico name={e.slice(4)} size={size} fb="🙂" style={style}/>;
  return <span style={{fontSize:size,lineHeight:1,...style}}>{e}</span>;
}

function GachaAnim({ result, onClose }) {
  const theme = result.theme || getMonthTheme();
  const isSuper = result.rate <= 3;             // 激レア(虹)
  const isSR    = result.rate <= 12;            // スーパーレア以上(金以上)
  const tier    = isSuper ? "super" : isSR ? "sr" : result.rate <= 25 ? "rare" : "normal";
  const TF      = ({normal:"n",rare:"r",sr:"sr",super:"super"})[tier]; // 最終レア度(額縁用)
  // レア度が上がるほど多段階でニョキニョキ育つ: 芽→つぼみ(青)→花(金)→大樹(虹)
  const STAGES  = result.simpleAnim ? [TF] : (isSuper ? ["n","r","super"] : isSR ? ["n","r","sr"] : (result.rate<=25 ? ["n","r"] : ["n"]));
  const AURA_OF = { n:"#eae2c8", r:"#4a9eff", sr:"#f5c842", super:"#f5c842" };

  const [phase, setPhase]       = useState("charge");   // charge→tap→grow→burst→show
  const [stage, setStage]       = useState(0);          // 成長段階(STAGESのindex)
  const timers = useRef([]);
  const at = (fn, ms) => { const t = setTimeout(fn, ms); timers.current.push(t); };
  useEffect(()=>()=>timers.current.forEach(clearTimeout), []);
  useEffect(()=>{ at(()=>setPhase(p=>p==="charge"?"tap":p), 600); }, []);

  const buzz = (pat)=>{ try{ navigator.vibrate(pat); }catch(e){} };
  // 確定演出(予兆): SR以上は水やり直前にそっと振動でワクワクを煽る
  useEffect(()=>{ if(isSR) at(()=>buzz(isSuper?[0,60,80,60,80,140]:[0,50,90,50]), 680); }, []);

  const HOLD = 1450, HUSH = isSuper ? 2300 : 1650;  // 段階ごとのタメ / 暗転の静寂(激レアほど長い)
  const hasHush = isSR && !result.simpleAnim;   // SR以上で暗転→解放（シンプル演出時はOFF）
  const reveal = () => {
    if(phase!=="tap") return;
    setPhase("grow"); setStage(0); buzz([60]);
    const last = STAGES.length-1;
    // 最終段の手前まで順に育てる＝わざと低レアっぽく見せる（裏切りの布石）
    for(let i=1;i<last;i++){ const j=i; at(()=>{ setStage(j); buzz([70]); }, i*HOLD); }
    if(hasHush){
      const hushT = last*HOLD;             // 最後の手前で暗転(静寂のタメ)
      at(()=>{ setPhase("hush"); buzz([30]); }, hushT);
      // 暗転中に加速する鼓動＝緊張を「充電」していく
      at(()=>buzz([40]), hushT+400);
      at(()=>buzz([60]), hushT+800);
      if(isSuper){ at(()=>buzz([90]), hushT+1100); at(()=>buzz([150]), hushT+1350); }
      const releaseT = hushT + HUSH;       // 限界までタメてから爆発的に解放
      at(()=>{ setStage(last); setPhase("burst"); buzz(isSuper?[0,90,40,40,560]:[0,340]); }, releaseT);
      at(()=>setPhase("show"), releaseT + 950);
    } else {
      if(last>0) at(()=>setStage(last), last*HOLD);
      const endT = last*HOLD + 900;
      at(()=>setPhase("burst"), endT);
      at(()=>setPhase("show"),  endT+520);
    }
  };
  const skip = () => { timers.current.forEach(clearTimeout); setStage(STAGES.length-1); setPhase("show"); };

  const curTier   = STAGES[Math.min(stage, STAGES.length-1)];
  const AURA      = AURA_OF[curTier];
  const rainbow   = curTier === "super";
  const grown     = phase==="grow" || phase==="hush" || phase==="burst" || phase==="show";
  const starCount = isSuper ? 30 : isSR ? 16 : 0;

  const PETALS = ["gacha_petal_pink1","gacha_petal_pink2","gacha_petal_pink3","gacha_petal_gold1","gacha_petal_gold2","gacha_petal_gold3","gacha_petal_blue1","gacha_petal_blue2"];
  const N = isSuper ? 34 : isSR ? 24 : 16;
  const [parts] = useState(()=> [...Array(N)].map((_,i)=>{
    const a = (Math.PI*2*i)/N + Math.random()*0.5;
    const d = 160 + Math.random()*240;
    return { tx:(Math.cos(a)*d).toFixed(0), ty:(Math.sin(a)*d).toFixed(0),
             img:PETALS[Math.floor(Math.random()*PETALS.length)], s:44+Math.round(Math.random()*42),
             rot:Math.round(Math.random()*720-360), dur:(1.2+Math.random()*0.8).toFixed(2),
             dl:(Math.random()*0.18).toFixed(2) };
  }));

  const stop = (e)=>{ e.stopPropagation(); };

  // ── 確定演出(予兆): SR以上で水やりの瞬間に発生。3種からランダムでワクワク ──
  const [premo] = useState(()=> isSR ? ["star","coin","firefly"][Math.floor(Math.random()*3)] : null);
  const [coins] = useState(()=> [...Array(16)].map(()=>({
    l:Math.round(Math.random()*100), s:18+Math.round(Math.random()*16),
    d:(Math.random()*1.4).toFixed(2), dur:(1.7+Math.random()*1.3).toFixed(2), rot:Math.round(Math.random()*40-20) })));
  const [flies] = useState(()=> [...Array(18)].map(()=>({
    l:Math.round(Math.random()*100), dx:Math.round(Math.random()*70-35), s:7+Math.round(Math.random()*9),
    d:(Math.random()*1.8).toFixed(2), dur:(2.2+Math.random()*1.7).toFixed(2),
    c:["#bff0c8","#ffe9a8","#bfe6ff","#ffd1ec"][Math.floor(Math.random()*4)] })));
  const premoTxt = premo==="coin" ? "コインが ふってきた…！？ 水を！🪙"
                 : premo==="firefly" ? "ひかりが あつまってる…！？ 水を！✨"
                 : premo==="star" ? "ながれ星が…！？ いそいで水を！🌠" : "タップして水をあげよう！💧";

  return (
    <div onClick={(phase==="grow"||phase==="burst")?skip:undefined}
      style={{position:"fixed",inset:0,zIndex:999,fontFamily:F,overflow:"hidden",background:"#1a1024"}}>

      <img src="/assets/gacha_stage_bg.png" alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",
        filter: phase==="charge"?"brightness(.7)":"brightness(1)",transition:"filter .6s ease"}}
        onError={e=>{e.target.style.display="none";}}/>
      <div style={{position:"absolute",inset:0,background:phase==="show"?"rgba(10,6,18,.35)":"rgba(10,6,18,.18)",transition:"background .5s"}}/>

      {grown && (curTier==="sr"||curTier==="super") && (
        <div key={"p"+stage} style={{position:"absolute",top:0,bottom:"18%",left:"50%",width:rainbow?190:110,transform:"translateX(-50%)",
          background:`linear-gradient(${rainbow?"#ffffff":AURA}00,${rainbow?"#ffffff":AURA}77,${rainbow?"#ffffff":AURA}00)`,
          filter:"blur(8px)",animation:"gPillar .7s ease-out",pointerEvents:"none"}}/>
      )}

      {grown && (
        <div style={{position:"absolute",left:"50%",bottom:"22%",transform:"translateX(-50%)",width:isSuper?340:240,height:isSuper?340:240,borderRadius:"50%",
          background: rainbow
            ? "conic-gradient(from 0deg,#ff3b3b,#ffb02e,#ffe53b,#3bd16f,#3b9eff,#9b5bff,#ff3b3b)"
            : `radial-gradient(circle,${AURA}aa 0%,${AURA}00 65%)`,
          filter:"blur(10px)",opacity:.85,animation: rainbow?"gRing 2.4s linear infinite":"gPulse 1s ease-in-out infinite",pointerEvents:"none"}}/>
      )}

      {/* ── 確定演出(予兆): 水やりの瞬間にSR以上で発生。虹は更にオーロラが重なる ── */}
      {(phase==="charge"||phase==="tap") && isSuper && (
        <div style={{position:"absolute",top:0,left:0,right:0,height:"52%",pointerEvents:"none",zIndex:2,overflow:"hidden"}}>
          {[0,1,2,3].map(i=>{const c=["#3bd16f","#3b9eff","#9b5bff","#ff5ea8"][i];return(
            <div key={"aur"+i} style={{position:"absolute",top:0,left:`${-25+i*22}%`,width:"78%",height:"100%",
              background:`linear-gradient(180deg,${c}00 0%,${c}88 42%,${c}00 100%)`,
              filter:"blur(20px)",mixBlendMode:"screen",
              animation:`gAurora ${3.6+i*0.7}s ease-in-out ${(i*0.4).toFixed(1)}s infinite alternate`}}/>);})}
        </div>
      )}
      {(phase==="charge"||phase==="tap") && premo==="star" && (
        <div style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:3,overflow:"hidden"}}>
          {[0,1,2,3].map(i=>(
            <div key={"shoot"+i} style={{position:"absolute",top:`${2+i*9}%`,left:0,width:150,height:3,
              borderRadius:3,background:isSuper?"linear-gradient(90deg,transparent,#bfe6ff,#fff)":"linear-gradient(90deg,transparent,#ffe9a8,#fff)",
              boxShadow:isSuper?"0 0 10px #bfe6ff":"0 0 10px #ffd86b",
              animation:`gShoot 2.2s linear ${(i*0.5).toFixed(2)}s infinite`}}/>
          ))}
        </div>
      )}
      {(phase==="charge"||phase==="tap") && premo==="coin" && (
        <div style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:3,overflow:"hidden"}}>
          {coins.map((c,i)=>(
            <span key={"coin"+i} style={{position:"absolute",left:`${c.l}%`,top:"-9%",fontSize:c.s,
              filter:"drop-shadow(0 0 6px #ffd86b)",animation:`gCoinFall ${c.dur}s ${c.d}s linear infinite`}}>🪙</span>
          ))}
        </div>
      )}
      {(phase==="charge"||phase==="tap") && premo==="firefly" && (
        <div style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:3,overflow:"hidden"}}>
          {flies.map((f,i)=>(
            <span key={"fly"+i} style={{position:"absolute",left:`${f.l}%`,bottom:"-4%",width:f.s,height:f.s,borderRadius:"50%",
              background:f.c,boxShadow:`0 0 ${f.s}px ${f.c}`,["--dx"]:`${f.dx}px`,
              animation:`gRise ${f.dur}s ${f.d}s ease-in-out infinite`}}/>
          ))}
        </div>
      )}

      {(phase==="charge"||phase==="tap") && (
        <div style={{position:"absolute",left:"50%",bottom:"22%",transform:"translateX(-50%)",textAlign:"center",cursor:phase==="tap"?"pointer":"default"}}
             onClick={phase==="tap"?reveal:undefined}>
          {phase==="tap" && <img src="/assets/gacha_can.png" alt="" style={{position:"absolute",left:-2,top:-70,width:78,transformOrigin:"30% 72%",animation:"gPour 1.8s ease-in-out infinite",pointerEvents:"none",filter:"drop-shadow(0 4px 8px rgba(0,0,0,.35))"}} onError={e=>{e.target.style.display="none";}}/>}
          {phase==="tap" && [0,1,2,3,4].map(i=>(
            <img key={"wd"+i} src="/assets/gacha_waterdrop.png" alt="" style={{position:"absolute",left:18+i*5,top:-12,width:10+(i%2)*4,animation:`gWdrop 1s ease-in ${(i*0.2).toFixed(2)}s infinite`,pointerEvents:"none"}} onError={e=>{e.target.style.display="none";}}/>
          ))}
          <img src="/assets/gacha_seed.png" alt="" style={{width:86,display:"block",margin:"0 auto",animation:phase==="tap"?"gSeedBob 1.1s ease-in-out infinite":"gSeedBob 1.6s ease-in-out infinite",filter:`drop-shadow(0 6px 12px ${AURA}cc)`}} onError={e=>{e.target.style.display="none";}}/>
        </div>
      )}

      {grown && (
        <div style={{position:"absolute",left:0,right:0,bottom:"21%",display:"flex",justifyContent:"center",alignItems:"flex-end",pointerEvents:"none"}}>
          <img key={stage} src={`/assets/gacha_grow_${curTier}.png`} alt=""
            style={{transformOrigin:"50% 100%",
              height:`${38+stage*7}vh`,width:"auto",maxWidth:"94vw",objectFit:"contain",
              animation:(phase==="grow")?"gNyoki .7s cubic-bezier(.2,.9,.3,1.4) forwards":(phase==="burst"&&hasHush)?"gNyoki .6s cubic-bezier(.15,.9,.3,1.5) forwards":"none",
              opacity:phase==="hush"?0.25:1,transition:"opacity .15s",
              filter:`drop-shadow(0 0 20px ${rainbow?"#ffffff":AURA}cc)`}}
            onError={e=>{e.target.style.display="none";}}/>
        </div>
      )}
      {phase==="grow" && (
        <div key={"puff"+stage} style={{position:"absolute",left:"50%",bottom:`${30+stage*6}%`,transform:"translateX(-50%)",pointerEvents:"none",zIndex:4}}>
          <div style={{position:"absolute",left:-65,top:-65,width:130,height:130,borderRadius:"50%",background:`radial-gradient(circle,${rainbow?"#ffffff":AURA}cc,transparent 66%)`,animation:"gPuff .6s ease-out forwards"}}/>
          {[...Array(rainbow?12:8)].map((_,i)=>{const ang=Math.PI*2*i/(rainbow?12:8);const dx=Math.round(Math.cos(ang)*(70+stage*8));const dy=Math.round(Math.sin(ang)*(70+stage*8));return <img key={i} src={`/assets/${PETALS[(i+stage)%PETALS.length]}.png`} alt="" style={{position:"absolute",left:0,top:0,width:22+stage*4,["--tx"]:`${dx}px`,["--ty"]:`${dy}px`,["--rot"]:`${i*44}deg`,animation:"gPetal .62s ease-out forwards"}} onError={e=>{e.target.style.display="none";}}/>;})}
        </div>
      )}

      {phase==="hush" && (
        <div style={{position:"absolute",inset:0,background:"rgba(22,10,42,0.8)",animation:"gHush .4s ease-in forwards",display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",zIndex:7,overflow:"hidden"}}>
          <div style={{position:"absolute",left:"50%",top:"47%",transform:"translate(-50%,-50%)",width:60,height:60,borderRadius:"50%",
            background: isSuper?"conic-gradient(from 0deg,#ff3b3b,#ffb02e,#ffe53b,#3bd16f,#3b9eff,#9b5bff,#ff3b3b)":"radial-gradient(circle,#ffffff,#f5c842)",
            filter:"blur(7px)",animation:`gCharge ${isSuper?1.45:0.95}s ease-in forwards`}}/>
          <div style={{position:"relative",color:"#fff",fontSize:30,fontWeight:900,letterSpacing:5,textShadow:"0 0 22px #fff",animation:"gHushBeat .42s ease-in-out infinite"}}>なにか 来る…！</div>
        </div>
      )}
      {phase==="burst" && <div style={{position:"absolute",inset:0,background: hasHush?"radial-gradient(circle at 50% 46%,#ffffff 0%,#fff0c2 28%,#ffd97a66 52%,#ffd97a00 80%)":"radial-gradient(circle at 50% 46%,#fff 0%,#fff8 45%,#fff0 75%)",animation:hasHush?"gFlash .6s ease-out":"gFlash .45s ease-out",pointerEvents:"none",zIndex:8}}/>}
      {(phase==="burst"||phase==="show") && (
        <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:6}}>
          {parts.map((p,i)=>(
            <img key={i} src={`/assets/${p.img}.png`} alt="" style={{position:"absolute",left:"50%",top:"45%",width:p.s,["--tx"]:`${p.tx}px`,["--ty"]:`${p.ty}px`,["--rot"]:`${p.rot}deg`,animation:`gPetal ${p.dur}s cubic-bezier(.15,.7,.3,1) ${p.dl}s forwards`}} onError={e=>{e.target.style.display="none";}}/>
          ))}
        </div>
      )}

      {(phase==="charge"||phase==="tap"||phase==="grow") && (
        <div style={{position:"absolute",top:"9%",left:0,right:0,textAlign:"center",pointerEvents:"none"}}>
          <div style={{fontSize:15,color:"rgba(255,255,255,0.75)",letterSpacing:1,marginBottom:6,textShadow:"0 2px 8px #000"}}>{theme.emoji} {theme.name}ガチャ</div>
          {(phase==="charge"||phase==="tap") && result.todayTasks>0 && <div style={{fontSize:13,color:"#bff0c8",fontWeight:800,marginBottom:8,textShadow:"0 2px 8px #000"}}>きょう {result.todayTasks}こ おてつだいしたから タネが げんき！🌱</div>}
          <div style={{fontSize:phase==="grow"&&isSuper?24:19,fontWeight:900,color:rainbow?"#fff":phase==="grow"?AURA:"#fff",textShadow:rainbow?"0 0 16px #fff,0 2px 8px #000":"0 2px 8px #000",animation:"fadePulse .8s ease-in-out infinite"}}>
            {phase==="charge" ? "タネを植えるよ…"
             : phase==="tap" ? (isSuper ? "そらが にじいろに…！？ 水をあげて！🌈" : premoTxt)
             : rainbow ? "にじいろの大樹だ‼"
             : curTier==="sr" ? "金の花が さいた…⁉"
             : curTier==="r" ? "ニョキッ！まだ育つ…！？"
             : "なにが育つかな…？"}
          </div>
          {(phase==="grow"||phase==="hush") && <div onClick={(e)=>{e.stopPropagation();skip();}} style={{display:"inline-block",marginTop:16,background:"rgba(255,255,255,.16)",border:"1.5px solid rgba(255,255,255,.55)",borderRadius:999,padding:"7px 20px",color:"#fff",fontSize:15,fontWeight:800,pointerEvents:"auto",cursor:"pointer"}}>スキップ ⏭</div>}
        </div>
      )}

      {phase==="show" && (
        <div style={{position:"absolute",left:0,right:0,bottom:0,padding:"30px 22px calc(28px + env(safe-area-inset-bottom))",
          background:"linear-gradient(to top,rgba(8,5,16,.92) 60%,rgba(8,5,16,0))",animation:"gCardUp .5s cubic-bezier(.2,.8,.3,1.1) forwards",textAlign:"center"}}>
          {starCount>0 && <div style={{position:"fixed",inset:0,pointerEvents:"none"}}>{[...Array(starCount)].map((_,i)=><span key={i} style={{position:"absolute",left:`${Math.random()*100}%`,top:"-5%",fontSize:isSuper?22:16,animation:`fall ${1.4+Math.random()*1.6}s ${Math.random()*.6}s linear forwards`}}>{"⭐✨🌟💫🎊"[i%5]}</span>)}</div>}
          <div style={{display:"inline-block",fontSize:12,color:"#1a1024",fontWeight:900,background:result.color,padding:"4px 16px",borderRadius:999,marginBottom:10,boxShadow:`0 0 18px ${result.color}aa`}}>{result.emoji} {result.label}</div>
          <div style={{position:"relative",width:130,height:130,margin:"0 auto 8px"}}>
            <img src={`/assets/gacha_frame_${TF}.png`} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",filter:`drop-shadow(0 0 12px ${result.color}aa)`,animation:isSuper?"gPulse2 1.6s ease-in-out infinite":"none"}} onError={e=>{e.target.style.display="none";}}/>
            <span style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:44,filter:`drop-shadow(0 0 8px ${result.color})`}}>{result.collItem?result.collItem.emoji:(isSuper?"👑":"🎁")}</span>
            {result.isNewItem&&<span style={{position:"absolute",top:2,right:2,background:R,color:"#fff",borderRadius:999,padding:"2px 9px",fontSize:11,fontWeight:900}}>NEW!</span>}
          </div>
          {result.collItem && <div style={{fontWeight:900,fontSize:17,color:"#fff",marginBottom:2}}>{result.collItem.name}</div>}
          {result.collItem && <div style={{fontSize:11,color:"rgba(255,255,255,.7)",marginBottom:result.collItem.edu?6:8}}>{result.collItem.desc}</div>}
          {result.collItem && result.collItem.edu && <div style={{fontSize:11.5,color:"#bff0c8",fontWeight:700,background:"rgba(52,199,123,.16)",borderRadius:10,padding:"7px 12px",margin:"0 auto 12px",maxWidth:300,lineHeight:1.55}}>💡 {result.collItem.edu}</div>}
          <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:6,marginBottom:result.bonusPts>0?6:16}}>
            <span style={{fontSize:24}}>🪙</span>
            <span style={{color:GOLD,fontSize:46,fontWeight:900,lineHeight:1,textShadow:"0 2px 10px #000"}}>+{result.pts}</span>
            <span style={{color:"rgba(255,255,255,.8)",fontSize:14,fontWeight:700}}>pt</span>
          </div>
          {result.bonusPts>0&&<div style={{display:"inline-block",background:GOLDS,borderRadius:10,padding:"5px 14px",marginBottom:14,fontSize:12,fontWeight:800,color:"#9a7000"}}>🔥 ストリークボーナス +{result.bonusPts}pt</div>}
          <div style={{display:"flex",gap:10,width:"100%",maxWidth:360,margin:"0 auto"}}>
            {isSR && <button onClick={(e)=>{stop(e);shareCard({emoji:result.collItem?result.collItem.emoji:(isSuper?"👑":"🎁"), img:result.collItem?`/assets/${result.collItem.id.replace("gi_","gacha_").replace("gm_","gacha_gm_")}.png`:null, rarity:result.label, title:result.collItem?`${result.collItem.name} が出た！`:`${result.label} が出た！`, subtitle:`ガチャで +${result.pts}pt`, color:result.color});}} style={{flex:1,background:"rgba(255,255,255,.14)",border:"1.5px solid rgba(255,255,255,.55)",borderRadius:16,padding:"15px 0",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>シェア 📤</button>}
            <button onClick={(e)=>{stop(e);onClose();}} style={{flex:1.5,background:result.color,border:"none",borderRadius:16,padding:"15px 0",color:"#1a1024",fontWeight:900,fontSize:17,cursor:"pointer",fontFamily:F,boxShadow:`0 6px 24px ${result.color}66`}}>{isSuper?"🎊 やったー！":"やったー🎉"}</button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes sp{to{transform:rotate(360deg)}}
        @keyframes pop{from{transform:scale(.3);opacity:0}to{transform:scale(1);opacity:1}}
        @keyframes fall{to{transform:translateY(110vh) rotate(360deg);opacity:0}}
        @keyframes heartbeat{0%,100%{transform:scale(1)}14%{transform:scale(1.22)}28%{transform:scale(1.08)}42%{transform:scale(1.26)}70%{transform:scale(1)}}
        @keyframes fadePulse{0%,100%{opacity:1}50%{opacity:0.45}}
        @keyframes gRing{to{transform:translateX(-50%) rotate(360deg)}}
        @keyframes gPulse{0%,100%{transform:translateX(-50%) scale(1);opacity:.75}50%{transform:translateX(-50%) scale(1.1);opacity:.95}}
        @keyframes gPillar{from{opacity:0;transform:translateX(-50%) scaleY(.25)}to{opacity:1;transform:translateX(-50%) scaleY(1)}}
        @keyframes gFlash{0%{opacity:0}12%{opacity:.7}100%{opacity:0}}
        @keyframes gBurst{from{transform:translate(-50%,-50%) scale(1);opacity:1}to{transform:translate(calc(-50% + var(--tx)),calc(-50% + var(--ty))) scale(.3);opacity:0}}
        @keyframes gGrow{0%{transform:translateX(-50%) scaleY(.04) scaleX(.5);opacity:.5}55%{transform:translateX(-50%) scaleY(1.07) scaleX(1.03);opacity:1}78%{transform:translateX(-50%) scaleY(.97) scaleX(.99)}100%{transform:translateX(-50%) scale(1);opacity:1}}
        @keyframes gNyoki{0%{transform:scaleY(.12);opacity:.3}50%{transform:scaleY(1.12);opacity:1}72%{transform:scaleY(.96)}88%{transform:scaleY(1.03)}100%{transform:scaleY(1);opacity:1}}
        @keyframes gPuff{0%{transform:scale(.3);opacity:.9}100%{transform:scale(1.9);opacity:0}}
        @keyframes gHush{from{opacity:0}to{opacity:1}}
        @keyframes gCharge{0%{transform:translate(-50%,-50%) scale(.25);opacity:.35}70%{opacity:.9}100%{transform:translate(-50%,-50%) scale(8);opacity:1}}
        @keyframes gHushBeat{0%,100%{transform:scale(1);opacity:.65}50%{transform:scale(1.22);opacity:1}}
        @keyframes gSeedBob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-6px) scale(1.05)}}
        @keyframes gPour{0%,100%{transform:rotate(8deg)}50%{transform:rotate(26deg)}}
        @keyframes gShoot{0%{transform:translate(-45vw,-22vh) rotate(30deg);opacity:0}4%{opacity:1}33%{opacity:1;transform:translate(128vw,32vh) rotate(30deg)}38%{opacity:0;transform:translate(128vw,32vh) rotate(30deg)}100%{opacity:0;transform:translate(128vw,32vh) rotate(30deg)}}
        @keyframes gAurora{0%{transform:translateX(-10%) scaleY(.88);opacity:.45}100%{transform:translateX(10%) scaleY(1.12);opacity:.92}}
        @keyframes gCoinFall{0%{transform:translateY(0) rotate(0deg);opacity:0}10%{opacity:1}85%{opacity:1}100%{transform:translateY(118vh) rotate(540deg);opacity:0}}
        @keyframes gRise{0%{transform:translate(0,0) scale(.5);opacity:0}15%{opacity:1}80%{opacity:.9}100%{transform:translate(var(--dx),-72vh) scale(1.1);opacity:0}}
        @keyframes gWdrop{0%{transform:translateY(0) scale(.7);opacity:0}25%{opacity:1}100%{transform:translateY(78px) scale(1);opacity:0}}
        @keyframes gPetal{0%{transform:translate(-50%,-50%) rotate(0deg) scale(.4);opacity:0}18%{opacity:1}100%{transform:translate(calc(-50% + var(--tx)),calc(-50% + var(--ty) + 50px)) rotate(var(--rot)) scale(1);opacity:0}}
        @keyframes gPulse2{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
        @keyframes gCardUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// BATTLE MODE (野生CPUと対戦・育てた度で強くなる・勝利でガチャチケット)
// ═══════════════════════════════════════════════════════
// 敵＝「なまけの闇」の手下＝悪いお金の習慣の化身。倒す＝その習慣に打ち勝つ(story/lessonで物語化)
const WILD_MONSTERS = [
  {name:"スライムン",  emoji:"🟢", lv:1, color:"#7bd88f", img:"wild_slime",  move:{n:"ねばねばショット", e:"🫧", c:"#7bd88f"},
    title:"さきのばしの精", story:"「あとでやろう」が口ぐせの さきのばしの精。ベタッと固まって 動けない。",
    lesson:"やることは 小さいうちに 片付けると ラク。先のばしは どんどん 重くなるよ。"},
  {name:"コウモリン",  emoji:"🦇", lv:2, color:"#9b8cff", img:"wild_bat",    move:{n:"ソニックウェーブ", e:"🌀", c:"#9b8cff"},
    title:"よくばりの使い", story:"光るものを見ると 全部ほしくなる よくばりの使い。",
    lesson:"「欲しい」と「必要」は ちがう。本当に いるか 考えてから 決めよう。"},
  {name:"トゲちゃん",  emoji:"🦔", lv:3, color:"#f0a35e", img:"wild_spike",  move:{n:"トゲミサイル", e:"📌", c:"#f0a35e"},
    title:"ムダづかいのトゲ", story:"衝動で チクチク 散財する ムダづかいのトゲ。",
    lesson:"買う前に ひと呼吸。「これ、本当に いる？」と 考えるクセを つけよう。"},
  {name:"ガイコツン",  emoji:"💀", lv:4, color:"#cfd6e0", img:"wild_bone",   move:{n:"ホネつぶて", e:"🦴", c:"#cfd6e0"},
    title:"からっぽガイコツ", story:"お金を 全部 使い切って 骨だけに なった ガイコツ。",
    lesson:"全部 使わず「とっておく分」を 残すと、いざという時 安心だよ。"},
  {name:"オニビ",      emoji:"🔥", lv:5, color:"#ff7a59", img:"wild_fire",   move:{n:"ひのたま", e:"🔥", c:"#ff7a59"},
    title:"しょうどうの炎", story:"「今すぐ買え！」と 燃え上がる しょうどうの炎。",
    lesson:"熱が冷めるまで 一晩 待とう。朝には いらなく なってるかも。"},
  {name:"ヌシ・ドラゴ",emoji:"🐉", lv:7, color:"#5fbf6f", img:"wild_dragon", move:{n:"りゅうのいぶき", e:"💥", c:"#5fbf6f"},
    title:"ためこみの主", story:"宝を ためこみすぎて 動けなくなった 森の主。",
    lesson:"ためるだけ じゃなく、使う・増やすで お金は 生きてくる。"},
  // ── 第二波: ヤミノオウ(Lv11)より格上の上位下僕。撃破後に出現＝ヒカリノオウへの道 ──
  {name:"バクチン",   emoji:"🎰", lv:22, color:"#e0564f", img:"wild_bakuchin", move:{n:"ルーレット", e:"🎲", c:"#e0564f"},
    title:"イチかバチかの罠", story:"「当たれば 大もうけ」と ささやく ギャンブルの化身。",
    lesson:"ギャンブルは 胴元(主催者)が 必ず とくする しくみ。確実には もうからないよ。"},
  {name:"シャッキング",emoji:"⛓", lv:24, color:"#8a6d3b", img:"wild_shakking", move:{n:"とりたて", e:"📜", c:"#8a6d3b"},
    title:"あと払いの沼", story:"「あとで 払えばいい」と 鎖を 巻きつける 借金の王。",
    lesson:"借りたお金は 利子をつけて 返す。返せる 範囲で だけ にしよう。"},
  {name:"ミエール",   emoji:"🎭", lv:26, color:"#c95fa0", img:"wild_mieru", move:{n:"みえばり", e:"💅", c:"#c95fa0"},
    title:"みんな持ってるの精", story:"「みんな 持ってるよ？」と あおる 見栄の仮面。",
    lesson:"人に 合わせて 買うと きりがない。自分にとって 必要かで 決めよう。"},
  {name:"ウマスギ",   emoji:"🐍", lv:28, color:"#5fbf6f", img:"wild_umasugi", move:{n:"あまいささやき", e:"🍯", c:"#5fbf6f"},
    title:"うますぎる話のヘビ", story:"「ぜったい もうかる」と ささやく 詐欺(さぎ)のヘビ。",
    lesson:"「絶対もうかる」は ウソ。うますぎる話は まず 疑おう。"},
  {name:"ローヒー",   emoji:"🌀", lv:30, color:"#7b61c9", img:"wild_rohi", move:{n:"ろうひの渦", e:"💸", c:"#7b61c9"},
    title:"つかいすぎの渦", story:"少しずつの ムダづかいを のみこんで ふくらむ 浪費の渦。",
    lesson:"何に 使ったか 記録(家計簿)しないと、お金は いつのまにか 消えるよ。"},
];
// 秘密のボス: ヌシ・ドラゴを倒すと出現
const BOSS_MONSTER = {name:"ヤミノオウ", emoji:"👑", lv:11, color:"#b07bff", img:"wild_boss", boss:true, move:{n:"ダークネスノヴァ", e:"🌑", c:"#b07bff"},
  title:"なまけの王", story:"なまけの闇で 世界を 覆った王。でも 心の奥には 眠った光が ある。",
  lesson:"なまけ(闇)も、毎日の お世話(努力)で 光に 変わる。倒した卵を 育ててみよう。"};
// 真の最終ボス(近日開放のティザー): 手下＋ヤミノオウを全て倒すと挑戦への道がひらく…が、今はまだ「？？？」で見えるだけ
const HIKARI_KING = {name:"ヒカリノオウ", emoji:"🌟", lv:"?", color:"#ffd24a", img:"hikari_king", coming:true,
  title:"真の 光の王", story:"なまけの闇を 完全に 祓った者だけが 挑める、真の王。すべての手下と ヤミノオウを 倒した先に、道が ひらく。",
  lesson:"つづける力で 闇を 光に変えた者に、最後の試練が おとずれる。…⚙ ただいま 準備中・近日 開放！"};
// そうび(アイテム): ぶき＋たての2スロット。レア度(rarity)と強さは別。premium=貯金/目標達成で解放する最強クラス
const EQUIPMENT = [
  // ── ぶき(weapon)＝こうげき系 ──
  {id:"eq_w_basic", slot:"weapon", rarity:1, name:"きほんのつるぎ", e:"🗡", atk:4, def:0, hp:0,  need:{k:"lv",v:1},     hint:"さいしょから"},
  {id:"eq_w_fire",  slot:"weapon", rarity:2, name:"ほのおのつるぎ", e:"🔥", atk:7, def:0, hp:0,  need:{k:"streak",v:7}, hint:"7日れんぞくで"},
  {id:"eq_w_brave", slot:"weapon", rarity:3, name:"ゆうきのつるぎ", e:"⚔", atk:11,def:0, hp:0,  need:{k:"wins",v:5},   hint:"バトル5勝で"},
  {id:"eq_w_star",  slot:"weapon", rarity:3, name:"スターロッド",   e:"🌟", atk:8, def:0, hp:12, need:{k:"lv",v:12},    hint:"レベル12で"},
  {id:"eq_w_thunder",slot:"weapon",rarity:4, name:"いかずちの剣",   e:"⚡", atk:17,def:0, hp:0,  need:{k:"bal",v:500},  premium:true, hint:"貯金500ptで"},
  {id:"eq_w_dragon", slot:"weapon",rarity:5, name:"りゅうおうの剣", e:"🐉", atk:23,def:0, hp:12, need:{k:"goals",v:3}, premium:true, hint:"目標を3回 達成で"},
  // ── たて(shield)＝ぼうぎょ系 ──
  {id:"eq_s_basic", slot:"shield", rarity:1, name:"きほんのたて",   e:"🔰", atk:0, def:4, hp:0,  need:{k:"tasks",v:10}, hint:"おてつだい10回で"},
  {id:"eq_s_guard", slot:"shield", rarity:2, name:"まもりのたて",   e:"🛡", atk:0, def:9, hp:0,  need:{k:"tasks",v:40}, hint:"おてつだい40回で"},
  {id:"eq_s_ribbon",slot:"shield", rarity:2, name:"げんきリボン",   e:"🎀", atk:0, def:2, hp:32, need:{k:"care",v:5},   hint:"なでなで5日で"},
  {id:"eq_s_crown", slot:"shield", rarity:3, name:"おうじゃのかんむり",e:"👑",atk:0, def:7, hp:26, need:{k:"lv",v:15},    hint:"レベル15で"},
  {id:"eq_s_diamond",slot:"shield",rarity:4, name:"ダイヤのよろい", e:"💎", atk:0, def:17,hp:22, need:{k:"bal",v:1000}, premium:true, hint:"貯金1000ptで"},
  {id:"eq_s_rainbow",slot:"shield",rarity:5, name:"にじのオーラ",   e:"🌈", atk:0, def:13,hp:42, need:{k:"goals",v:5}, premium:true, hint:"目標を5回 達成で"},
  // ── モンスター固有ドロップ武器(そのモンスターを倒すと低確率で入手・図鑑対応)。need:dropは条件解放されず、ドロップ限定 ──
  {id:"eq_w_slime", slot:"weapon", rarity:2, name:"スライムソード", e:"🟢", atk:6, def:0, hp:4,  need:{k:"drop",v:1}, dropFrom:"wild_slime",  hint:"スライムンを 倒すと"},
  {id:"eq_w_bat",   slot:"weapon", rarity:2, name:"ナイトファング", e:"🦇", atk:9, def:0, hp:0,  need:{k:"drop",v:1}, dropFrom:"wild_bat",    hint:"コウモリンを 倒すと"},
  {id:"eq_w_spike", slot:"weapon", rarity:3, name:"トゲのやり",     e:"📌", atk:12,def:3, hp:0,  need:{k:"drop",v:1}, dropFrom:"wild_spike",  hint:"トゲちゃんを 倒すと"},
  {id:"eq_w_bone",  slot:"weapon", rarity:3, name:"ボーンブレード", e:"🦴", atk:15,def:0, hp:0,  need:{k:"drop",v:1}, dropFrom:"wild_bone",   hint:"ガイコツンを 倒すと"},
  {id:"eq_w_flame", slot:"weapon", rarity:4, name:"フレイムランス", e:"🔥", atk:18,def:0, hp:6,  need:{k:"drop",v:1}, dropFrom:"wild_fire",   hint:"オニビを 倒すと"},
  {id:"eq_w_drago", slot:"weapon", rarity:4, name:"ドラゴンクロー", e:"🐲", atk:22,def:0, hp:8,  need:{k:"drop",v:1}, dropFrom:"wild_dragon", hint:"ヌシ・ドラゴを 倒すと"},
  {id:"eq_w_yami",  slot:"weapon", rarity:5, name:"ヤミノツルギ",   e:"🌑", atk:28,def:0, hp:14, need:{k:"drop",v:1}, dropFrom:"wild_boss",   hint:"ヤミノオウを 倒すと"},
];
const EQ_SLOTS=[{k:"weapon",t:"⚔ ぶき"},{k:"shield",t:"🛡 たて"}];
const EQ_RAR=(r)=>({1:{n:"N",c:"#7c8a82"},2:{n:"R",c:"#3478D4"},3:{n:"SR",c:"#7B61C9"},4:{n:"SR+",c:"#E8B83E"},5:{n:"UR",c:"#D95C55"}}[r]||{n:"N",c:"#7c8a82"});
// 回復カプセル(バトルドロップ・低確率)。小=50回復 / 中=100回復
const HEAL_CAPS=[
  {k:"hs", name:"回復カプセル小", e:"🟢", img:"heal_cap_s", heal:50,  rate:0.10, c:"#34C77B"},
  {k:"hm", name:"回復カプセル中", e:"🔵", img:"heal_cap_m", heal:100, rate:0.04, c:"#3478D4"},
];
// 回復アイテムの所持上限(持ちすぎ防止)。上限に達したらそれ以上は増えない(換金などはしない)
const HEAL_MAX = 9;
// 回復アイテムを1つ入手。上限未満なら所持+1、満タンなら何もしない(打ち止め)
function gainHealItem(d, cid, kind){
  if(kind==="potion"){
    const cur=(d.healPotions?.[cid])||0;
    if(cur>=HEAL_MAX) return d;
    return {...d, healPotions:{...(d.healPotions||{}),[cid]:cur+1}};
  }
  const cc={...(d.healCaps?.[cid]||{})}; const cur=cc[kind]||0;
  if(cur>=HEAL_MAX) return d;
  cc[kind]=cur+1;
  return {...d, healCaps:{...(d.healCaps||{}),[cid]:cc}};
}
// サポートなかま: お手伝い数で加入(週間・3回ごと最大3体)。タイプは週ごとランダム固定。固定効果=弱い子ほど相対的に効く
// タネの精霊(がんばりの光): お手伝いの努力で目をさます3体。役割は固定、名前・物語つき
const SUP_TYPES=[
  {k:"atk", e:"⚔", name:"コツン",  sprite:"sup_kotsun", role:"アタッカー", desc:"ときどき 敵に ついげき。コツコツ続ける力の精霊", awaken:"コツンが めをさました！"},
  {k:"heal",e:"💚", name:"メグミ",  sprite:"sup_megumi", role:"ヒーラー",   desc:"ときどき HPを かいふく。分け合う優しさの精霊", awaken:"メグミが めをさました！"},
  {k:"rng", e:"🎲", name:"ラッキー",sprite:"sup_lucky",  role:"きまぐれ",   desc:"ときどき 攻撃か回復を ランダム。運とチャレンジの精霊", awaken:"ラッキーが めをさました！"},
];
const SUP_PER=3, SUP_MAX=3, SUP_ATK=10, SUP_HEAL=20;
// その子の今週のサポートなかま(お手伝い数から導出・保存不要)
function supportBuddies(data, child){
  const week=Math.floor(Date.now()/(7*86400000));
  const start=week*7*86400000;
  const chores=(data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")&&new Date(l.date).getTime()>=start).length;
  const count=Math.min(SUP_MAX,Math.floor(chores/SUP_PER));
  const h=s=>{let n=0;for(const c of String(s))n=(n*31+c.charCodeAt(0))%9973;return n;};
  const list=Array.from({length:count},(_,i)=>SUP_TYPES[h(child.id+"_"+week+"_"+i)%3]);
  const next=count<SUP_MAX?(SUP_PER-(chores%SUP_PER)):0;
  return {list, chores, count, next};
}
function equipMeta(data, child){
  const m=getMonState(data,child);
  return { lv:monLevel((data.monsterExp||{})[child.id]||0).lv, tasks:m.tasksDone||0, care:m.careDays||0,
           wins:(data.battleWins||{})[child.id]||0, streak:(data.streak||{})[child.id]?.max||0,
           bal:(data.logs||[]).filter(l=>l.cid===child.id).reduce((a,l)=>a+l.pts,0),
           goals:(data.goals||[]).filter(g=>g.cid===child.id&&g.done).length };
}
const equipUnlocked = (item, meta, dropped)=> ((meta[item.need.k]||0) >= item.need.v) || (Array.isArray(dropped) && dropped.includes(item.id));
// 自分のモンスターの技(進化先=curIdごとに固定で割り当て→姿が変わると技も変わる)
const PLAYER_MOVES = [
  {n:"エナジーボール", e:"🔆", c:"#34C77B"},
  {n:"スターショット", e:"⭐", c:"#ffd24a"},
  {n:"はっぱカッター", e:"🍃", c:"#5fd17a"},
  {n:"アクアジェット", e:"💧", c:"#4a9eff"},
  {n:"マジックフレア", e:"✨", c:"#b07bff"},
  {n:"こがねブラスト", e:"🪙", c:"#E8B83E"},
  {n:"いなずまスパーク", e:"⚡", c:"#ffe14a"},
];
const pickMove = (id)=> PLAYER_MOVES[[...String(id||"")].reduce((a,c)=>a+c.charCodeAt(0),0) % PLAYER_MOVES.length];
// レベル(EXP→Lv)。お手伝い・バトルでEXPが貯まる。Lvが上がるとステ上昇(IVは伸び率=才能)
function monLevel(exp){ let lv=1,need=60,e=exp||0; while(e>=need&&lv<50){e-=need;lv++;need=Math.round(need*1.16);} return {lv,into:Math.round(e),need}; }
// レベル称号(レベル帯で変わる)
function monRank(lv){ return lv>=40?"でんせつ":lv>=25?"たつじん":lv>=15?"いっぱし":lv>=7?"みならい":"かけだし"; }
// バトルのステータス(進化段階 × レベル(努力) × IV(才能))を一元化
function battleStats(data, child){
  const m=getMonState(data,child); const iv=(data.monsterIV||{})[child.id]||{hp:5,atk:5,def:5,spd:5};
  const L=monLevel((data.monsterExp||{})[child.id]||0); const lv=L.lv;
  const eqRaw=(data.monsterEquip||{})[child.id];
  const eqIds=(eqRaw&&typeof eqRaw==="object")?[eqRaw.weapon,eqRaw.shield]:(eqRaw?[eqRaw]:[]);
  const eqItems=eqIds.map(id=>EQUIPMENT.find(e=>e.id===id)).filter(Boolean);
  const eb=(k)=>eqItems.reduce((s,e)=>s+(e[k]||0),0);
  // 基礎倍率: B=全体+5%底上げ / A=ヤミノタマゴのドロップ毎+1%(累積・永続)。装備ぶん(eb)は倍率外で加算
  const eggDrops=(data.eggDrops||{})[child.id]||0;
  const reincPower=(data.reincPower||{})[child.id]||0;   // 転生プレステージ(到達Lvの累計)。0.5%/Lv
  const baseMul=1.05*(1+0.01*eggDrops+0.005*reincPower);
  return {
    hp: Math.round((50+(m.stage||0)*22+Math.round(lv*(3+(iv.hp||5)*0.5))+(m.careDays||0)*2)*baseMul)+eb("hp"),
    atk:Math.round((10+(m.stage||0)*4+Math.round(lv*(1.2+(iv.atk||5)*0.18))+Math.floor((m.gauge||0)/6))*baseMul)+eb("atk"),
    def:Math.round((5+(m.stage||0)*3+Math.round(lv*(0.8+(iv.def||5)*0.14)))*baseMul)+eb("def"),
    spd:Math.round((6+(m.stage||0)*2+Math.round(lv*(0.6+(iv.spd||5)*0.12)))*baseMul)+eb("spd"),
    lv, exp:L, iv, equip:eqItems, eggDrops,
    curId:m.curId, name:(data.monsterNickname||{})[child.id]||m.def?.name||m.def?.label||"あいぼう",
    move:pickMove(m.curId), img:m.def?.gs?`/assets/gacha_gs_${m.def.gs}_a.png`:`/assets/monster_${m.curId}_f0.png`,
  };
}
// HP自然回復: 1分で1回復(時間経過ぶんを保存値に加算)
const HP_REGEN_MS=60000;
// ── 家族バトル: 戦闘力(BP)とハンデ ──
function battlePower(data, member){ const s=battleStats(data,member); return Math.round(s.atk*3 + s.def*3 + s.hp + (s.spd||0)*2); }
// 年齢ハンデ(年下ほど有利・親はひかえめ)＝総合戦闘力ランキングを公平に
function bpHandicap(member){
  if(member.isParent || member.role==="parent" || member.displayMode==="adult") return 0.85;
  if(member.displayMode==="junior") return 1.35;
  if(member.ageMode==="young") return 1.2;
  return 1.0;
}
function regenHP(stored, ts, max){
  const regen = ts ? Math.floor((Date.now()-ts)/HP_REGEN_MS) : 0;
  return Math.max(0, Math.min(max, stored + Math.max(0,regen)));
}
// 現在HP(日替わりで全回復・バトルで減ったら持ち越し・1分1回復で自然回復)
function curMonHP(data, child){
  const max=battleStats(data,child).hp;
  const stored=(data.monsterHP||{})[child.id];
  const sameDay=(data.monsterHPDate||{})[child.id]===todayKey();
  if(!(sameDay && stored!==undefined)) return max;
  return regenHP(stored,(data.monsterHPTs||{})[child.id]||0,max);
}
// お世話で回復(ratio=最大HPの割合ぶん回復)。満タンなら何もしない
function healMon(d, cid, ratio){
  const max=battleStats(d,{id:cid}).hp;
  const sameDay=(d.monsterHPDate||{})[cid]===todayKey();
  const cur=(sameDay && (d.monsterHP||{})[cid]!==undefined)?regenHP((d.monsterHP||{})[cid],(d.monsterHPTs||{})[cid]||0,max):max;
  if(cur>=max) return d;
  return {...d, monsterHP:{...(d.monsterHP||{}),[cid]:Math.min(max,Math.round(cur+max*ratio))}, monsterHPDate:{...(d.monsterHPDate||{}),[cid]:todayKey()}, monsterHPTs:{...(d.monsterHPTs||{}),[cid]:Date.now()}};
}
// お世話/勝利で HP回復 ＋ EXP付与(ratio=0なら回復なし)
function careMon(d, cid, ratio, exp){
  let nd = ratio?healMon(d,cid,ratio):d;
  if(exp){ nd={...nd, monsterExp:{...(nd.monsterExp||{}),[cid]:((nd.monsterExp||{})[cid]||0)+exp}}; }
  return nd;
}
const TASK_EXP_CAP = 300; // タスク由来EXPの1日上限(連打青天井の防止)
// タスクEXP: HP回復＋EXP。ただし1日の上限あり(超過分は付与しない)
function careCap(d, cid, ratio, rawExp){
  let nd = ratio?healMon(d,cid,ratio):d;
  const today=todayKey(); const te=(nd.taskExpDay||{})[cid];
  const used=(te&&te.date===today)?(te.amt||0):0;
  const grant=Math.max(0, Math.min(Math.round(rawExp), TASK_EXP_CAP-used));
  if(grant>0){ nd={...nd, monsterExp:{...(nd.monsterExp||{}),[cid]:((nd.monsterExp||{})[cid]||0)+grant}, taskExpDay:{...(nd.taskExpDay||{}),[cid]:{date:today,amt:used+grant}}}; }
  return nd;
}
function HPBar({label,hp,max,color}){
  const pct=Math.max(0,Math.round(hp/max*100));
  return (<div>
    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"rgba(255,255,255,.85)",fontWeight:800,marginBottom:3}}><span>{label}</span><span>{Math.max(0,hp)}/{max}</span></div>
    <div style={{height:12,borderRadius:999,background:"rgba(255,255,255,.15)",overflow:"hidden"}}><div style={{height:"100%",width:`${pct}%`,background:pct>50?color:pct>20?"#f5c842":"#e0564f",borderRadius:999,transition:"width .4s"}}/></div>
  </div>);
}
function EquipModal({child,data,update,onClose}){
  const meta=equipMeta(data,child);
  const dropped=(data.equipUnlock||{})[child.id]||[];
  const eqRaw=(data.monsterEquip||{})[child.id];
  const cur=(eqRaw&&typeof eqRaw==="object")?eqRaw:{};
  const stats=battleStats(data,child);
  const obtainable=EQUIPMENT;
  const collected=obtainable.filter(it=>equipUnlocked(it,meta,dropped)).length;
  // プレミア装備は「条件を満たした瞬間」に永続解放(equipUnlockへ記録)＝
  // あとで貯金を使って残高が条件未満に戻っても再ロックされない(once-unlock)。
  useEffect(()=>{
    const newly=EQUIPMENT.filter(it=>it.premium && !dropped.includes(it.id) && (meta[it.need.k]||0)>=it.need.v);
    if(newly.length){ update(d=>{ const drp=(d.equipUnlock?.[child.id])||[]; const add=newly.map(it=>it.id).filter(id=>!drp.includes(id)); if(!add.length)return d; return {...d, equipUnlock:{...(d.equipUnlock||{}),[child.id]:[...drp,...add]}}; }); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const setEq=(slot,id)=>update(d=>{ const r=(d.monsterEquip||{})[child.id]; const obj=(r&&typeof r==="object")?r:{}; return {...d,monsterEquip:{...(d.monsterEquip||{}),[child.id]:{...obj,[slot]:id}}}; });
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:1200,background:"rgba(8,6,18,.6)",display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}}>
      <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:480,maxHeight:"86vh",background:BG,borderRadius:"22px 22px 0 0",display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"16px 18px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}>
          <span style={{fontWeight:900,fontSize:17,color:TEXT}}>🎒 そうび図鑑 <span style={{fontSize:12,color:MUTED,fontWeight:700}}>{collected}/{obtainable.length}</span></span>
          <button onClick={onClose} style={{background:CARDS,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,padding:"6px 12px",fontWeight:800,cursor:"pointer",fontFamily:F}}>とじる</button>
        </div>
        <div style={{padding:"10px 16px 4px",fontSize:12,color:TEXTS,fontWeight:700}}>いまの強さ：HP {stats.hp} ・ ⚔{stats.atk} ・ 🛡{stats.def}</div>
        <div style={{overflowY:"auto",padding:"6px 16px calc(20px + env(safe-area-inset-bottom))"}}>
          {EQ_SLOTS.map(sl=>(
            <div key={sl.k}>
              <div style={{fontWeight:900,fontSize:13,color:TEXT,margin:"8px 2px 6px"}}>{sl.t}</div>
              {EQUIPMENT.filter(it=>it.slot===sl.k).map(it=>{
                const unlocked=equipUnlocked(it,meta,dropped); const on=cur[sl.k]===it.id; const rar=EQ_RAR(it.rarity);
                return <div key={it.id} style={{background:on?GS:CARD,border:`2px solid ${on?GP:(it.premium?rar.c+"66":BORDER)}`,borderRadius:14,padding:"10px 12px",marginBottom:8,display:"flex",alignItems:"center",gap:11,opacity:unlocked?1:(it.premium?0.92:0.6)}}>
                  <div style={{width:34,height:34,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,filter:unlocked?"none":"grayscale(1) brightness(.7)"}}><img src={`/assets/${it.id}.png`} alt="" style={{width:"100%",height:"100%",objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent=it.e;e.target.replaceWith(s);}}/></div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:9,fontWeight:900,color:"#fff",background:rar.c,borderRadius:5,padding:"1px 5px"}}>{rar.n}</span>
                      <span style={{fontWeight:800,fontSize:14,color:TEXT}}>{(unlocked||it.premium)?it.name:"？？？"}</span>
                      {it.premium&&<span style={{fontSize:9,fontWeight:900,color:"#fff",background:GOLD,borderRadius:5,padding:"1px 5px"}}>✨プレミア</span>}
                    </div>
                    <div style={{fontSize:11,color:B,fontWeight:700,marginTop:2}}>{[it.hp?`HP+${it.hp}`:"",it.atk?`⚔+${it.atk}`:"",it.def?`🛡+${it.def}`:""].filter(Boolean).join("  ")}</div>
                    {!unlocked&&<div style={{fontSize:11,color:it.premium?rar.c:MUTED,fontWeight:it.premium?800:400,marginTop:2}}>🔒 {it.hint}</div>}
                  </div>
                  {unlocked&&<button onClick={()=>setEq(sl.k,on?null:it.id)} style={{background:on?MUTED:GP,border:"none",borderRadius:10,padding:"8px 13px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F,flexShrink:0}}>{on?"はずす":"そうび"}</button>}
                  {!unlocked&&it.premium&&<span style={{fontSize:18,flexShrink:0}}>🔒</span>}
                </div>;
              })}
            </div>
          ))}
          <div style={{textAlign:"center",color:MUTED,fontSize:11,marginTop:6}}>お手伝い・なでなで・連続・バトルや、まれにドロップで集まるよ</div>
        </div>
      </div>
    </div>
  );
}
function BattleModal({child,data,update,onClose}){
  const stats  = battleStats(data,child);
  const pMaxHP = stats.hp, pATK = stats.atk, pDEF = stats.def, pSPD = stats.spd, pImg = stats.img, pName = stats.name, pMove = stats.move;
  const curHP  = curMonHP(data,child);
  const lowHP  = curHP < Math.max(20, Math.round(pMaxHP*0.2));
  const fragNow = (data.battleFragments||{})[child.id]||0;
  const ticketNow = (data.battleTickets||{})[child.id]||0;
  // ポイントでHP回復(おこづかいの使い道＝トレードオフを学ぶ)
  const myBalB = (data.logs||[]).filter(l=>l.cid===child.id).reduce((s,l)=>s+l.pts,0);
  const healCost = Math.max(10, Math.round((pMaxHP-curHP)*0.5));
  const healByPoints = ()=>{
    if(curHP>=pMaxHP || myBalB<healCost) return;
    update(d=>{ const e={id:uid(),cid:child.id,type:"reward",label:"💊 げんきドリンク（バトル回復）",pts:-healCost,date:new Date().toISOString()}; addLogToFirestore(e);
      return {...d, logs:[e,...d.logs], monsterHP:{...(d.monsterHP||{}),[child.id]:pMaxHP}, monsterHPDate:{...(d.monsterHPDate||{}),[child.id]:todayKey()}, monsterHPTs:{...(d.monsterHPTs||{}),[child.id]:Date.now()}}; });
  };
  const potions=(data.healPotions||{})[child.id]||0;
  const [,setHpTick]=useState(0);  // 1分1回復を画面に反映するための再描画タイマー
  useEffect(()=>{const id=setInterval(()=>setHpTick(t=>t+1),20000);return()=>clearInterval(id);},[]);
  const useHealItem=()=>{ if(curHP>=pMaxHP||potions<=0)return; update(d=>({...d, healPotions:{...(d.healPotions||{}),[child.id]:Math.max(0,((d.healPotions?.[child.id])||0)-1)}, monsterHP:{...(d.monsterHP||{}),[child.id]:pMaxHP}, monsterHPDate:{...(d.monsterHPDate||{}),[child.id]:todayKey()}, monsterHPTs:{...(d.monsterHPTs||{}),[child.id]:Date.now()}})); };
  const caps=(data.healCaps||{})[child.id]||{};
  const sup=supportBuddies(data,child);   // 今週のサポートなかま
  // 発動確率: 弱い(低Lv=小さい子)ほど よく手伝い、強い(高Lv=高校生)ほど 稀に。年齢バランス自動調整
  const supChance=Math.max(0.15, Math.min(0.85, 0.85 - (stats.lv||1)*0.025));
  const useCap=(cap)=>{ if(curHP>=pMaxHP||((caps[cap.k]||0)<=0))return; const newHP=Math.min(curMonHP(data,child)+cap.heal,pMaxHP); update(d=>{ const cc={...(d.healCaps?.[child.id]||{})}; cc[cap.k]=Math.max(0,(cc[cap.k]||0)-1); return {...d, healCaps:{...(d.healCaps||{}),[child.id]:cc}, monsterHP:{...(d.monsterHP||{}),[child.id]:newHP}, monsterHPDate:{...(d.monsterHPDate||{}),[child.id]:todayKey()}, monsterHPTs:{...(d.monsterHPTs||{}),[child.id]:Date.now()}}; }); };
  const [oppIdx,setOppIdx]=useState(0);
  const [showSeason,setShowSeason]=useState(false);
  const [enemyInfo,setEnemyInfo]=useState(null);  // 敵の物語ポップ
  const [supFlash,setSupFlash]=useState(false);   // サポート精霊が手伝った時のフラッシュ
  const [auto,setAuto]=useState(()=>{try{return localStorage.getItem("tane_autobattle")==="1";}catch(e){return false;}});  // オートバトル
  const toggleAuto=()=>setAuto(a=>{const n=!a;try{localStorage.setItem("tane_autobattle",n?"1":"0");}catch(e){} return n;});
  const opp = oppIdx>=WILD_MONSTERS.length ? BOSS_MONSTER : WILD_MONSTERS[oppIdx];
  const bossUnlocked = !!(data.battleBossUnlocked||{})[child.id];
  const oMaxHP = 50 + opp.lv*28;
  const oATK   = 9 + opp.lv*5;
  const oDEF   = 4 + opp.lv*3;
  const oSPD   = 5 + opp.lv*2 + (opp.boss?6:0);   // 敵の素早さ(ボスは速い)
  const MAXR=3;
  const [phase,setPhase]=useState("select");
  const [pHP,setPHP]=useState(curHP);
  const [oHP,setOHP]=useState(oMaxHP);
  const [round,setRound]=useState(1);
  const [busy,setBusy]=useState(true);
  const [proj,setProj]=useState(null);
  const [hit,setHit]=useState(null);
  const [vs,setVs]=useState(false);
  const [log,setLog]=useState("");
  const [result,setResult]=useState(null);
  const [reward,setReward]=useState(null);
  const [drop,setDrop]=useState(null); // たまのドロップ {kind:"potion"|"equip", name}
  const [confetti]=useState(()=>[...Array(30)].map(()=>({x:Math.round(Math.random()*100),s:14+Math.round(Math.random()*18),d:(1.6+Math.random()*1.6).toFixed(2),dl:(Math.random()*0.9).toFixed(2),e:"⭐✨🎉🎊💫🎟🌟"[Math.floor(Math.random()*7)]})));
  const timers=useRef([]);
  const t=(fn,ms)=>{const id=setTimeout(fn,ms);timers.current.push(id);};
  useEffect(()=>()=>timers.current.forEach(clearTimeout),[]);
  const [afrm,setAfrm]=useState(0); // 敵の3コマアニメ用
  useEffect(()=>{const id=setInterval(()=>setAfrm(f=>f+1),380);return()=>clearInterval(id);},[]);
  const oppSrc = opp.boss ? `/assets/${opp.img}.png` : `/assets/${opp.img}_${afrm%3}.png`;
  const [showEquip,setShowEquip]=useState(false);
  const buzz=p=>{try{navigator.vibrate(p);}catch(e){}};
  const dmgCalc=(atk,def)=>Math.max(1, Math.round((atk - def*0.5) * (0.85+Math.random()*0.3)));
  // 保護者の「1日のバトル回数」制限(familySettings.dailyBattleLimit, 0=無制限)
  const battleLimit=(data.familySettings?.dailyBattleLimit)||0;
  const _bcd=(data.battleCountDay||{})[child.id];
  const battlesToday=(_bcd && _bcd.date===todayKey())?(_bcd.n||0):0;
  const battleLimitReached=battleLimit>0 && battlesToday>=battleLimit;
  const start=(i)=>{ if(lowHP) return;
    if(battleLimitReached){ setLog("きょうの バトルは ここまで！また あした⚔"); return; }
    update(d=>{ const p=(d.battleCountDay||{})[child.id]; const n=(p&&p.date===todayKey())?(p.n||0):0; return {...d, battleCountDay:{...(d.battleCountDay||{}),[child.id]:{date:todayKey(),n:n+1}}}; });
    const o=i>=WILD_MONSTERS.length?BOSS_MONSTER:WILD_MONSTERS[i]; setOppIdx(i); setPHP(curHP); setOHP(50+o.lv*28); setRound(1); setResult(null); setReward(null); setDrop(null); setHit(null); setProj(null); setLog(""); setPhase("fight"); setVs(true); setBusy(true); buzz([30,60,30]); t(()=>{setVs(false);setBusy(false);setLog("こうげきして！");},1100); };
  const finish=(r,finalHP)=>{
    setResult(r); setLog(r==="win"?"WIN！":"LOSE…"); buzz(r==="win"?[0,80,40,80,40,200]:[300]);
    const today=todayKey();
    const hpSave=Math.max(0,Math.round(finalHP));
    const unlockBoss=(r==="win") && opp.lv>=7 && !opp.boss;
    const expGain=(r==="win") ? battleExp(opp) : Math.round(battleExp(opp)*0.25);  // 強い敵ほど多い・負けても少しもらえる
    // チケットのかけら: 勝利でかけら+1(同じモンスターは1日1かけらまで)。5枚で🎟チケット1枚に
    const oppKey=opp.boss?"boss":String(oppIdx);
    const fragDateOk=(data.battleFragDate||{})[child.id]===today;
    const wonOpps=fragDateOk?((data.battleFragOpps||{})[child.id]||[]):[];
    const canFrag=(r==="win") && !wonOpps.includes(oppKey);
    const curFrag=(data.battleFragments||{})[child.id]||0;
    const converted=canFrag && (curFrag+1>=5);  // 表示用(WIN演出)。実際の書き込みはupdate内でdから再計算
    if(r==="win") setReward(canFrag?(converted?"ticket":"fragment"):"none");
    // ドロップ(勝利時): ①ヤミノオウは稀に卵 ②そのモンスター固有のレア武器(未所持なら優先) ③回復アイテム
    let dropInfo=null;
    if(r==="win"){
      const drp=(data.equipUnlock?.[child.id])||[];
      const sigItem=EQUIPMENT.find(it=>it.dropFrom===opp.img);          // このモンスター固有の武器
      const sigOwned=sigItem && drp.includes(sigItem.id);
      if(opp.boss && Math.random()<0.15){
        dropInfo={kind:"egg"};   // ヤミノタマゴ: 初回は育成卵、毎回 基礎ステ+1%(累積)
      } else if(sigItem && !sigOwned && Math.random()<0.32){
        dropInfo={kind:"equip",id:sigItem.id,name:sigItem.name,e:sigItem.e};   // 固有レア武器ドロップ
      } else {
        const roll=Math.random();
        if(roll<0.10) dropInfo={kind:"cap",cap:"hs"};        // 回復カプセル小(50) 10%
        else if(roll<0.14) dropInfo={kind:"cap",cap:"hm"};   // 回復カプセル中(100) 4% ※低め
        else if(roll<0.22){ const locked=EQUIPMENT.filter(it=>!it.premium && !it.dropFrom && !equipUnlocked(it,equipMeta(data,child),drp)); if(locked.length){ const pick=locked[Math.floor(Math.random()*locked.length)]; dropInfo={kind:"equip",id:pick.id,name:pick.name,e:pick.e}; } }
      }
    }
    if(dropInfo) setDrop(dropInfo);
    update(d=>{ let nd={...d};
      nd.monsterHP={...(d.monsterHP||{}),[child.id]:hpSave};        // 残りHPを持ち越し
      nd.monsterHPDate={...(d.monsterHPDate||{}),[child.id]:today};
      nd.monsterHPTs={...(d.monsterHPTs||{}),[child.id]:Date.now()}; // 1分1回復の起点
      nd.monsterExp={...(d.monsterExp||{}),[child.id]:((d.monsterExp?.[child.id])||0)+expGain};  // バトルEXP
      if(r==="win"){
        nd.battleWins={...(d.battleWins||{}),[child.id]:((d.battleWins?.[child.id])||0)+1};
        nd.battleWinDate={...(d.battleWinDate||{}),[child.id]:today};  // 「今日1勝したか」=ミッション判定用
        nd.enemyDex={...(d.enemyDex||{}),[child.id]:Array.from(new Set([...((d.enemyDex?.[child.id])||[]),opp.img]))};  // 図鑑: 倒した敵を登録
      }
      if(dropInfo?.kind==="potion") nd=gainHealItem(nd,child.id,"potion");
      if(dropInfo?.kind==="cap") nd=gainHealItem(nd,child.id,dropInfo.cap);
      if(dropInfo?.kind==="equip"){ const drp=(d.equipUnlock?.[child.id])||[]; nd.equipUnlock={...(d.equipUnlock||{}),[child.id]:[...drp,dropInfo.id]}; }
      if(dropInfo?.kind==="egg"){
        nd.eggDrops={...(d.eggDrops||{}),[child.id]:((d.eggDrops?.[child.id])||0)+1};   // 基礎ステ+1%(累積)
        if(!(d.yamiEgg?.[child.id]) && !String((d.monsterEvolved||{})[child.id]||"").startsWith("yami")) nd.yamiEgg={...(d.yamiEgg||{}),[child.id]:true};  // 倒した本人だけが ヤミノオウのタマゴ入手(育成は通常タネモンと同じ。既に育成中なら配らない)
      }
      // かけら計算は同期後の最新値(d)から行う＝多端末でのスナップショット二重加算/喪失を防ぐ
      if(r==="win"){
        const dFragDateOk=(d.battleFragDate||{})[child.id]===today;
        const dWonOpps=dFragDateOk?((d.battleFragOpps||{})[child.id]||[]):[];
        if(!dWonOpps.includes(oppKey)){
          const dCur=(d.battleFragments||{})[child.id]||0;
          const dConv=dCur+1>=5;
          nd.battleFragments={...(d.battleFragments||{}),[child.id]:dConv?(dCur+1-5):(dCur+1)};
          if(dConv) nd.battleTickets={...(d.battleTickets||{}),[child.id]:((d.battleTickets?.[child.id])||0)+1};
          nd.battleFragDate={...(d.battleFragDate||{}),[child.id]:today};
          nd.battleFragOpps={...(d.battleFragOpps||{}),[child.id]:[...dWonOpps,oppKey]};
        }
      }
      if(unlockBoss){ nd.battleBossUnlocked={...(d.battleBossUnlocked||{}),[child.id]:true}; }
      return nd; });
  };
  const finishByHP=(o,p)=> finish((p/pMaxHP) >= (o/oMaxHP) ? "win" : "lose", p);
  // 1ターン=素早い方から攻撃→相手の攻撃。3ターンで決着(KOが無ければHP割合で判定)
  const doRound=()=>{
    if(busy||result||phase!=="fight") return;
    setBusy(true);
    const dp=dmgCalc(pATK,oDEF); const newO=Math.max(0,oHP-dp);
    const de=dmgCalc(oATK,pDEF); const newP=Math.max(0,pHP-de);
    const pFirst = pSPD>=oSPD;   // 素早さが高い方が先攻(同値は自分)
    const pHit=(cb)=>{ setLog(`${pName}の ${pMove.n}！`); setProj("p");
      t(()=>{ setProj(null); setHit({who:"opp",dmg:dp}); setOHP(newO); buzz([45]); t(()=>setHit(null),450); cb(); },470); };
    const oHit=(cb)=>{ setLog(`${opp.name}の ${opp.move.n}！`); setProj("o");
      t(()=>{ setProj(null); setHit({who:"player",dmg:de}); setPHP(newP); buzz([70]); t(()=>setHit(null),450); cb(); },470); };
    const endTurn=()=>{
      // サポートなかまの行動(稀に発動・弱い子ほど高確率): ⚔追撃 / 💚回復 / 🎲きまぐれ
      let bd=0,bh=0;
      sup.list.forEach(b=>{ if(Math.random()>=supChance) return; if(b.k==="atk") bd+=SUP_ATK; else if(b.k==="heal") bh+=SUP_HEAL; else { const r=Math.random(); if(r<0.5) bd+=SUP_ATK; else if(r<0.85) bh+=SUP_HEAL; } });
      const fO=Math.max(0,newO-bd), fP=Math.min(pMaxHP,newP+bh);
      if(bd||bh){ setLog(`🤝 サポートなかま！${bd?` ⚔-${bd}`:""}${bh?` 💚+${bh}`:""}`); setSupFlash(true); t(()=>setSupFlash(false),800); if(bd){setOHP(fO);setHit({who:"opp",dmg:bd});t(()=>setHit(null),450);} if(bh) setPHP(fP); buzz([25]); }
      t(()=>{
        if(bd && fO<=0){ finish("win",fP); return; }
        if(round>=MAXR){ finishByHP(fO,fP); } else { setRound(r=>r+1); setLog("つぎの ターン！"); setBusy(false); }
      }, (bd||bh)?760:0);
    };
    if(pFirst){
      pHit(()=>{ if(newO<=0){ t(()=>finish("win",pHP),720); return; }
        t(()=> oHit(()=>{ if(newP<=0){ t(()=>finish("lose",0),720); return; } t(endTurn,520); }), 560); });
    } else {
      setLog(`${opp.name}は すばやい！`);
      t(()=> oHit(()=>{ if(newP<=0){ t(()=>finish("lose",0),720); return; }
        t(()=> pHit(()=>{ if(newO<=0){ t(()=>finish("win",newP),720); return; } t(endTurn,520); }), 560); }), 360);
    }
  };
  // オートバトル: ONなら待機中(攻撃可能)に自動でこうげき
  useEffect(()=>{
    if(auto && phase==="fight" && !busy && !result){
      const id=setTimeout(()=>doRound(), 600);
      return ()=>clearTimeout(id);
    }
  },[auto,phase,busy,result,round]);
  // ワイルド敵カード(レベル順表示で再利用)
  const renderWildCard=(w,i)=>{
    const opw=(50+w.lv*28)+(9+w.lv*5)+(4+w.lv*3);
    const tough=opw>(pMaxHP+pATK+pDEF)*0.9;
    const os=5+w.lv*2; const fst=pSPD>=os;
    return (
      <button key={w.img} onClick={lowHP?undefined:()=>start(i)} style={{position:"relative",background:"rgba(255,255,255,.06)",border:`1.5px solid ${w.color}66`,borderRadius:16,padding:"14px 8px",cursor:lowHP?"default":"pointer",opacity:lowHP?.45:1,fontFamily:F,textAlign:"center"}}>
        <span onClick={e=>{e.stopPropagation();setEnemyInfo(w);}} style={{position:"absolute",top:6,right:8,width:20,height:20,borderRadius:"50%",background:"rgba(255,255,255,.14)",color:"#fff",fontSize:12,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",zIndex:2}}>?</span>
        <img src={`/assets/${w.img}.png`} style={{width:48,height:48,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent=w.emoji;s.style.fontSize="38px";e.target.replaceWith(s);}}/>
        <div style={{color:"#fff",fontWeight:800,fontSize:13,marginTop:4}}>{w.name}</div>
        <div style={{fontSize:11,color:w.color,fontWeight:800,marginTop:2}}>Lv.{w.lv}{tough?" 🔥":""}</div>
        <div style={{fontSize:10.5,color:fst?"#7fe0a0":"#ff9a8a",fontWeight:800,marginTop:1}}>⚡{os} {fst?"先制できる":"敵が先制"}</div>
        <div style={{fontSize:11,color:"#ffd24a",fontWeight:800,marginTop:1}}>かつと 🆙+{battleExp(w)}</div>
      </button>
    );
  };
  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"#070611",fontFamily:F,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{padding:"calc(12px + env(safe-area-inset-top)) 16px 8px",display:"flex",alignItems:"center",justifyContent:"space-between",zIndex:5}}>
        <span style={{color:"#7fe0ff",fontWeight:900,fontSize:15,letterSpacing:1,textShadow:"0 0 8px #2aa0ff"}}>⚔ デジタルバトル</span>
        <button onClick={onClose} style={{background:"rgba(255,255,255,.12)",border:"none",borderRadius:10,color:"#fff",padding:"6px 12px",fontWeight:800,cursor:"pointer",fontFamily:F}}>とじる</button>
      </div>
      {phase==="select" && (
        <div style={{flex:1,overflowY:"auto",padding:"4px 18px 30px"}}>
          {battleLimit>0 && (
            <div style={{margin:"2px auto 10px",maxWidth:320,textAlign:"center",fontSize:12,fontWeight:800,color:battleLimitReached?"#ffb4b4":"#bff0c8",background:"rgba(255,255,255,.07)",border:"1px solid rgba(255,255,255,.14)",borderRadius:10,padding:"7px 12px"}}>
              {battleLimitReached?"🌙 きょうの バトルは ここまで！また あした":`⚔ きょうの バトル のこり ${Math.max(0,battleLimit-battlesToday)}回（保護者せってい）`}
            </div>
          )}
          <div style={{textAlign:"center",color:"#fff",marginBottom:14}}>
            <img src={pImg} style={{width:90,height:90,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{e.target.src="/assets/monster_egg_f0.png";}}/>
            <div style={{fontWeight:900,fontSize:15}}>{pName}</div>
            <div style={{fontSize:12,color:"#bda7ff",marginTop:2}}>Lv.{stats.lv} · ⚔{pATK} · 🛡{pDEF} · ⚡{pSPD}{stats.eggDrops>0?` · 🥚+${stats.eggDrops}%`:""}</div>
            <div style={{width:190,maxWidth:"82%",margin:"6px auto 0"}}><HPBar label="HP" hp={curHP} max={pMaxHP} color={lowHP?"#e0564f":"#34C77B"}/></div>
            <div style={{width:190,maxWidth:"82%",margin:"5px auto 0"}}><HPBar label="EXP" hp={stats.exp.into} max={stats.exp.need} color="#ffd24a"/></div>
            {/* 🤝 サポートなかま(お手伝い数で加入・バトルを手伝う) */}
            <div style={{margin:"9px auto 0",maxWidth:300,background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.14)",borderRadius:12,padding:"8px 12px"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{fontSize:12,fontWeight:800,color:"#ffe9a8"}}>🤝 サポートなかま</span>
                {sup.count>0
                  ? sup.list.map((b,i)=><span key={i} title={b.role+"："+b.desc} style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:12,fontWeight:800,color:"#fff",background:"rgba(255,255,255,.1)",borderRadius:8,padding:"2px 7px"}}><img src={`/assets/${b.sprite}_a.png`} alt="" style={{width:18,height:18,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent=b.e;e.target.replaceWith(s);}}/>{b.name}<span style={{fontSize:9,color:"rgba(255,255,255,.55)"}}>({b.e})</span></span>)
                  : <span style={{fontSize:11,color:"rgba(255,255,255,.5)"}}>まだ いないよ</span>}
              </div>
              <div style={{fontSize:10,color:"rgba(255,255,255,.5)",textAlign:"center",marginTop:4}}>
                {sup.count<SUP_MAX?`お手伝い あと${sup.next}回で なかま+1（今週${sup.chores}回）`:`今週は なかま最大の ${SUP_MAX}体！`}・ときどき手伝うよ（よわい子ほど よく手伝う）
              </div>
            </div>
            {curHP<pMaxHP && <div style={{marginTop:8,display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
              {potions>0 && <button onClick={useHealItem} style={{background:"#7b61c9",border:"none",borderRadius:999,padding:"6px 12px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F,display:"inline-flex",alignItems:"center",gap:4}}><img src="/assets/heal_potion.png" alt="" style={{width:18,height:18,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent="💊";e.target.replaceWith(s);}}/>フル回復 ×{potions}</button>}
              {HEAL_CAPS.map(cap=>((caps[cap.k]||0)>0)&&(
                <button key={cap.k} onClick={()=>useCap(cap)} style={{background:cap.c,border:"none",borderRadius:999,padding:"6px 12px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F,display:"inline-flex",alignItems:"center",gap:4}}><img src={`/assets/${cap.img}.png`} alt="" style={{width:18,height:18,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent=cap.e;e.target.replaceWith(s);}}/>+{cap.heal} ×{caps[cap.k]}</button>
              ))}
              <button onClick={healByPoints} disabled={myBalB<healCost} style={{background:myBalB<healCost?"rgba(255,255,255,.12)":"#34C77B",border:"none",borderRadius:999,padding:"7px 14px",color:"#fff",fontWeight:800,fontSize:12,cursor:myBalB<healCost?"default":"pointer",fontFamily:F}}>💊 ポイントで({healCost}pt){myBalB<healCost?"・たりない":""}</button>
            </div>}
            <div style={{fontSize:11,color:"rgba(255,255,255,.5)",marginTop:5}}>お手伝い・なでなで・進化で つよくなる！（3ターン勝負）</div>
          </div>
          {lowHP && <div style={{background:"rgba(224,86,79,.15)",border:"1.5px solid #e0564f",borderRadius:12,padding:"10px 12px",marginBottom:10,textAlign:"center"}}>
            <div style={{color:"#ffb3ae",fontWeight:800,fontSize:13}}>つかれて たたかえない…💤</div>
            <div style={{color:"rgba(255,255,255,.6)",fontSize:11,marginTop:2}}>お手伝い・なでなで で かいふくしよう！（あさになると 元気に）</div>
          </div>}
          <button onClick={()=>setShowEquip(true)} style={{width:"100%",marginBottom:12,background:"rgba(255,255,255,.07)",border:"1.5px solid rgba(255,255,255,.2)",borderRadius:14,padding:"11px",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>🎒 そうび図鑑{stats.equip&&stats.equip.length?`（${stats.equip.map(e=>e.e).join("")}）`:""}</button>
          <button onClick={()=>setShowSeason(true)} style={{width:"100%",marginBottom:12,background:"linear-gradient(135deg,#E8B83E,#d99a2b)",border:"none",borderRadius:14,padding:"12px",color:"#3a2a00",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:F,display:"flex",alignItems:"center",justifyContent:"center",gap:8,boxShadow:"0 4px 16px rgba(232,184,62,.4)"}}>🏆 家族バトル・シーズン（順位を見る）</button>
          <div style={{color:"rgba(255,255,255,.7)",fontSize:12,fontWeight:800,margin:"0 0 8px"}}>あいてを えらぶ</div>
          {(()=>{const bd=(data.enemyDex?.[child.id]||[]).includes("wild_boss");return bd&&(
            <div style={{fontSize:11,color:"#ffd24a",fontWeight:800,marginBottom:8}}>⚡ ヤミノオウ撃破！さらに 格上の手下が あらわれた…</div>
          );})()}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {/* レベル順: Lv11以下のワイルド → ヤミノオウ(11) → 上位下僕(撃破後) */}
            {WILD_MONSTERS.map((w,i)=>({w,i})).filter(x=>x.w.lv<=11).map(x=>renderWildCard(x.w,x.i))}
            {bossUnlocked ? (
              <button onClick={lowHP?undefined:()=>start(WILD_MONSTERS.length)} style={{position:"relative",background:"linear-gradient(135deg,rgba(176,123,255,.22),rgba(80,40,140,.25))",border:`2px solid ${BOSS_MONSTER.color}`,borderRadius:16,padding:"14px 8px",cursor:lowHP?"default":"pointer",opacity:lowHP?.45:1,fontFamily:F,textAlign:"center",boxShadow:`0 0 16px ${BOSS_MONSTER.color}66`}}>
                <span onClick={e=>{e.stopPropagation();setEnemyInfo(BOSS_MONSTER);}} style={{position:"absolute",top:6,right:8,width:20,height:20,borderRadius:"50%",background:"rgba(255,255,255,.18)",color:"#fff",fontSize:12,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",zIndex:2}}>?</span>
                <img src={`/assets/${BOSS_MONSTER.img}.png`} style={{width:50,height:50,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent=BOSS_MONSTER.emoji;s.style.fontSize="40px";e.target.replaceWith(s);}}/>
                <div style={{color:"#fff",fontWeight:900,fontSize:13,marginTop:4}}>{BOSS_MONSTER.name}</div>
                <div style={{fontSize:11,color:BOSS_MONSTER.color,fontWeight:900,marginTop:2}}>Lv.{BOSS_MONSTER.lv} 👑ボス</div>
                {(()=>{const os=5+BOSS_MONSTER.lv*2+6;const f=pSPD>=os;return <div style={{fontSize:10.5,color:f?"#7fe0a0":"#ff9a8a",fontWeight:800,marginTop:1}}>⚡{os} {f?"先制できる":"敵が先制"}</div>;})()}
                <div style={{fontSize:11,color:"#ffd24a",fontWeight:800,marginTop:1}}>かつと 🆙+{battleExp(BOSS_MONSTER)}</div>
              </button>
            ) : (
              <div style={{background:"rgba(255,255,255,.04)",border:"1.5px dashed rgba(255,255,255,.2)",borderRadius:16,padding:"14px 8px",textAlign:"center",opacity:.8}}>
                <div style={{fontSize:38,filter:"brightness(0) opacity(.55)"}}>👑</div>
                <div style={{color:"rgba(255,255,255,.5)",fontWeight:800,fontSize:13,marginTop:4}}>？？？</div>
                <div style={{fontSize:11,color:"rgba(255,255,255,.4)",fontWeight:700,marginTop:2}}>🔒 ヌシをたおすと…</div>
              </div>
            )}
            {/* 上位下僕(Lv12〜)はヤミノオウの後＝レベル順。撃破後のみ */}
            {(data.enemyDex?.[child.id]||[]).includes("wild_boss") && WILD_MONSTERS.map((w,i)=>({w,i})).filter(x=>x.w.lv>11).map(x=>renderWildCard(x.w,x.i))}
            {/* 🌟 真の最終ボス ヒカリノオウ(ティザー・近日開放。手下＋ヤミノオウ全撃破で道がひらく) */}
            {(()=>{
              const dex=data.enemyDex?.[child.id]||[];
              const all=[...WILD_MONSTERS,BOSS_MONSTER];
              const got=all.filter(e=>dex.includes(e.img)).length;
              const cleared=got>=all.length;
              return (
                <div onClick={()=>setEnemyInfo(HIKARI_KING)} style={{gridColumn:"1 / -1",position:"relative",background:cleared?"linear-gradient(135deg,rgba(255,210,74,.18),rgba(255,255,255,.06))":"rgba(255,255,255,.04)",border:cleared?"2px solid #ffd24a":"1.5px dashed rgba(255,255,255,.22)",borderRadius:16,padding:"14px 10px",textAlign:"center",cursor:"pointer",overflow:"hidden",boxShadow:cleared?"0 0 18px rgba(255,210,74,.4)":"none"}}>
                  <span style={{position:"absolute",top:6,right:8,width:20,height:20,borderRadius:"50%",background:"rgba(255,255,255,.18)",color:"#fff",fontSize:12,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",zIndex:2}}>?</span>
                  <div style={{fontSize:34,filter:cleared?"none":"grayscale(1) brightness(1.4) opacity(.6)",animation:cleared?"btIdle 2.6s ease-in-out infinite":"none"}}>🌟</div>
                  <div style={{color:cleared?"#ffe9a8":"rgba(255,255,255,.55)",fontWeight:900,fontSize:14,marginTop:2}}>？？？<span style={{fontSize:11,marginLeft:6,color:"#ffd24a"}}>真の王</span></div>
                  <div style={{fontSize:11,color:cleared?"#ffd24a":"rgba(255,255,255,.45)",fontWeight:800,marginTop:3}}>
                    {cleared?"✨ 近日 開放！（準備中）":`🔒 手下を ぜんぶ倒すと… ${got}/${all.length}`}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
      {phase==="fight" && (
        <div style={{flex:1,position:"relative",overflow:"hidden",backgroundColor:"#0a0a18",backgroundImage:"linear-gradient(rgba(90,170,255,.10) 1px,transparent 1px),linear-gradient(90deg,rgba(90,170,255,.10) 1px,transparent 1px)",backgroundSize:"26px 26px"}}>
          <div style={{position:"absolute",top:10,left:14,width:"45%"}}><HPBar label={opp.name} hp={oHP} max={oMaxHP} color={opp.color}/></div>
          <div style={{position:"absolute",bottom:14,right:14,width:"45%"}}><HPBar label={pName} hp={pHP} max={pMaxHP} color="#34C77B"/></div>
          <div style={{position:"absolute",top:44,left:0,right:0,textAlign:"center",color:"#7fe0ff",fontWeight:900,fontSize:13,letterSpacing:3,textShadow:"0 0 6px #2aa0ff"}}>ROUND {Math.min(round,MAXR)} / {MAXR}</div>
          <div style={{position:"absolute",right:"12%",top:"22%",textAlign:"center"}}>
            <img src={oppSrc} style={{width:opp.boss?156:98,height:opp.boss?156:98,objectFit:"contain",imageRendering:"pixelated",filter:hit?.who==="opp"?"brightness(3) drop-shadow(0 0 12px #fff)":(opp.boss?`drop-shadow(0 0 20px ${opp.color})`:"none"),animation:hit?.who==="opp"?"btShake .4s":(opp.boss?"btIdle 2.6s ease-in-out infinite":"none")}} onError={e=>{const t=e.target;if(!t.dataset.fb){t.dataset.fb="1";t.src=`/assets/${opp.img}.png`;}else{const s=document.createElement("span");s.textContent=opp.emoji;s.style.fontSize="64px";t.replaceWith(s);}}}/>
            {hit?.who==="opp"&&<div style={{position:"absolute",top:-8,left:"50%",fontSize:30,fontWeight:900,color:"#ffd24a",textShadow:"0 2px 6px #000",animation:"btDmg .6s ease-out"}}>-{hit.dmg}</div>}
          </div>
          <div style={{position:"absolute",left:"8%",bottom:"26%",textAlign:"center"}}>
            <img src={pImg} style={{width:104,height:104,objectFit:"contain",imageRendering:"pixelated",filter:hit?.who==="player"?"brightness(3) drop-shadow(0 0 10px #fff)":"none",animation:hit?.who==="player"?"btShake .4s":"btIdle 2.4s ease-in-out infinite"}} onError={e=>{e.target.src="/assets/monster_egg_f0.png";}}/>
            {hit?.who==="player"&&<div style={{position:"absolute",top:-8,left:"50%",fontSize:30,fontWeight:900,color:"#ff6a6a",textShadow:"0 2px 6px #000",animation:"btDmg .6s ease-out"}}>-{hit.dmg}</div>}
          </div>
          {/* 🤝 サポート精霊: プレイヤー側に並ぶ。手伝った時に光ってジャンプ */}
          {sup.count>0 && (
            <div style={{position:"absolute",left:"5%",bottom:"6%",display:"flex",gap:3,zIndex:3}}>
              {sup.list.map((b,i)=>(
                <img key={i} src={`/assets/${b.sprite}_a.png`} title={b.name} style={{width:36,height:36,objectFit:"contain",imageRendering:"pixelated",filter:supFlash?"brightness(1.5) drop-shadow(0 0 8px #fff)":"drop-shadow(0 1px 2px #000)",animation:supFlash?`btSupJump .7s ease-out ${i*0.1}s`:`btIdle 2.8s ease-in-out infinite ${i*0.2}s`}} onError={e=>{const s=document.createElement("span");s.textContent=b.e;s.style.fontSize="28px";e.target.replaceWith(s);}}/>
              ))}
            </div>
          )}
          {proj==="p"&&<div style={{position:"absolute",left:"24%",bottom:"42%",fontSize:30,filter:`drop-shadow(0 0 10px ${pMove.c})`,animation:"btProjP .45s linear forwards",zIndex:4}}>{pMove.e}</div>}
          {proj==="o"&&<div style={{position:"absolute",right:"24%",top:"32%",fontSize:30,filter:`drop-shadow(0 0 10px ${opp.move.c})`,animation:"btProjO .45s linear forwards",zIndex:4}}>{opp.move.e}</div>}
          {vs&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",zIndex:6}}><div style={{fontSize:64,fontWeight:900,color:"#fff",textShadow:"0 0 22px #ff3b6b,0 0 8px #fff",animation:"btVs 1.1s ease-out"}}>VS</div></div>}
          {result==="win"&&(
            <div style={{position:"absolute",inset:0,zIndex:9,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",overflow:"hidden",background:"radial-gradient(circle at 50% 44%,rgba(255,210,74,.4),rgba(7,6,17,.86))"}}>
              <div style={{position:"absolute",width:"170%",height:"170%",background:"conic-gradient(from 0deg,rgba(255,210,74,.18),transparent 24deg,rgba(255,210,74,.18) 48deg,transparent 72deg,rgba(255,210,74,.18) 96deg,transparent 120deg,rgba(255,210,74,.18) 144deg,transparent 168deg,rgba(255,210,74,.18) 192deg,transparent 216deg,rgba(255,210,74,.18) 240deg,transparent 264deg,rgba(255,210,74,.18) 288deg,transparent 312deg,rgba(255,210,74,.18) 336deg,transparent 360deg)",animation:"btRays 9s linear infinite"}}/>
              {confetti.map((c,i)=><span key={i} style={{position:"absolute",left:`${c.x}%`,top:"-6%",fontSize:c.s,animation:`btConf ${c.d}s linear ${c.dl}s infinite`}}>{c.e}</span>)}
              <img src={pImg} style={{width:124,height:124,objectFit:"contain",imageRendering:"pixelated",zIndex:2,animation:"btWinJump 1s ease-in-out infinite",filter:"drop-shadow(0 0 16px #ffd24a)"}} onError={e=>{e.target.src="/assets/monster_egg_f0.png";}}/>
              <div style={{fontSize:56,fontWeight:900,color:"#fff",letterSpacing:2,textShadow:"0 0 26px #ffd24a,0 0 8px #fff",zIndex:2,marginTop:4,animation:"btWinText .6s cubic-bezier(.2,.9,.3,1.4)"}}>WIN！</div>
              {reward==="ticket"&&<div style={{marginTop:8,fontSize:16,fontWeight:900,color:"#fff5cc",zIndex:2,textShadow:"0 2px 8px #000",animation:"btWinText .8s ease-out"}}>🧩×5 → 🎟 ガチャチケット 完成！</div>}
              {reward==="fragment"&&<div style={{marginTop:8,fontSize:15,fontWeight:900,color:"#cfe6ff",zIndex:2,textShadow:"0 2px 8px #000",animation:"btWinText .8s ease-out"}}>🧩 チケットのかけら GET！（{fragNow}/5）</div>}
              {reward==="none"&&<div style={{marginTop:8,fontSize:12,fontWeight:700,color:"rgba(255,255,255,.7)",zIndex:2,textShadow:"0 2px 8px #000"}}>このモンスターの かけらは きょうGET済み（EXPはGET！）</div>}
              {drop?.kind==="potion"&&<div style={{marginTop:8,fontSize:15,fontWeight:900,color:"#bff0c8",zIndex:2,textShadow:"0 2px 8px #000",animation:"btWinText 1s ease-out"}}>💊 かいふくアイテムを 見つけた！</div>}
              {drop?.kind==="cap"&&(()=>{const cap=HEAL_CAPS.find(c=>c.k===drop.cap);return <div style={{marginTop:8,fontSize:15,fontWeight:900,color:"#bff0c8",zIndex:2,textShadow:"0 2px 8px #000",animation:"btWinText 1s ease-out"}}>{cap.e} {cap.name}（HP{cap.heal}回復）を 見つけた！</div>;})()}
              {drop?.kind==="equip"&&<div style={{marginTop:8,fontSize:15,fontWeight:900,color:"#ffd9a8",zIndex:2,textShadow:"0 2px 8px #000",animation:"btWinText 1s ease-out"}}>🎁 そうび「{drop.e}{drop.name}」を 見つけた！</div>}
              {drop?.kind==="egg"&&<div style={{marginTop:8,fontSize:15,fontWeight:900,color:"#e0c7ff",zIndex:2,textShadow:"0 2px 8px #000",animation:"btWinText 1s ease-out"}}>🥚 ヤミノタマゴ 獲得！基礎ステータス +1%（お世話で育つ）</div>}
            </div>
          )}
          {result==="lose"&&(
            <div style={{position:"absolute",inset:0,zIndex:9,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"rgba(5,5,12,.84)"}}>
              <img src={pImg} style={{width:98,height:98,objectFit:"contain",imageRendering:"pixelated",filter:"grayscale(.85) brightness(.6)",transform:"rotate(-7deg)",animation:"btShake .5s"}} onError={e=>{e.target.src="/assets/monster_egg_f0.png";}}/>
              <div style={{fontSize:46,fontWeight:900,color:"#9aa3b2",letterSpacing:2,textShadow:"0 2px 8px #000",marginTop:10,animation:"btLoseText .6s ease-out"}}>LOSE…</div>
              <div style={{fontSize:13,color:"rgba(255,255,255,.6)",marginTop:8}}>もっと お世話して つよくなろう！</div>
            </div>
          )}
        </div>
      )}
      {phase!=="select" && (
        <div style={{padding:"10px 18px calc(18px + env(safe-area-inset-bottom))",background:"rgba(0,0,0,.45)",zIndex:5}}>
          {!result && <>
            <div style={{color:"#cfe6ff",fontSize:12,fontWeight:700,textAlign:"center",minHeight:18,marginBottom:8}}>{log}</div>
            <div style={{display:"flex",gap:8,alignItems:"stretch"}}>
              <button onClick={doRound} disabled={busy||auto} style={{flex:1,background:(busy||auto)?"rgba(255,255,255,.15)":"linear-gradient(135deg,#ff7a59,#ff3b6b)",border:"none",borderRadius:14,padding:"15px",color:"#fff",fontWeight:900,fontSize:17,cursor:(busy||auto)?"default":"pointer",fontFamily:F}}>{auto?"オート中…⚙":(busy?"…":"こうげき！⚔")}</button>
              <button onClick={toggleAuto} style={{flexShrink:0,width:78,background:auto?"linear-gradient(135deg,#34C77B,#1f9c5a)":"rgba(255,255,255,.12)",border:auto?"none":"1.5px solid rgba(255,255,255,.25)",borderRadius:14,color:"#fff",fontWeight:900,fontSize:13,cursor:"pointer",fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1}}>
                <span style={{fontSize:16}}>{auto?"⏸":"▶"}</span>
                <span>オート{auto?"ON":"OFF"}</span>
              </button>
            </div>
          </>}
          {result && (
            <div style={{textAlign:"center"}}>
              <div style={{color:"rgba(255,255,255,.6)",fontSize:12,marginBottom:10}}>🧩 かけら {fragNow}/5 ・ 🎟 チケット {ticketNow}まい</div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>{setPhase("select");setResult(null);}} style={{flex:1,background:"rgba(255,255,255,.15)",border:"none",borderRadius:12,padding:"13px",color:"#fff",fontWeight:800,cursor:"pointer",fontFamily:F}}>もういちど</button>
                <button onClick={onClose} style={{flex:1,background:"#34C77B",border:"none",borderRadius:12,padding:"13px",color:"#fff",fontWeight:900,cursor:"pointer",fontFamily:F}}>おわる</button>
              </div>
            </div>
          )}
        </div>
      )}
      <style>{`
        @keyframes btShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-9px)}60%{transform:translateX(9px)}}
        @keyframes btDmg{0%{transform:translateX(-50%) translateY(0) scale(.6);opacity:0}30%{opacity:1;transform:translateX(-50%) scale(1.25)}100%{transform:translateX(-50%) translateY(-34px);opacity:0}}
        @keyframes btIdle{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
        @keyframes btSupJump{0%{transform:translateY(0) scale(1)}30%{transform:translateY(-16px) scale(1.25)}60%{transform:translateY(-4px) scale(1.1)}100%{transform:translateY(0) scale(1)}}
        @keyframes btProjP{0%{transform:translate(0,0) scale(.6);opacity:0}15%{opacity:1}100%{transform:translate(56vw,-26vh) scale(1.15);opacity:1}}
        @keyframes btProjO{0%{transform:translate(0,0) scale(.6);opacity:0}15%{opacity:1}100%{transform:translate(-56vw,24vh) scale(1.15);opacity:1}}
        @keyframes btVs{0%{transform:scale(2.6);opacity:0}25%{transform:scale(1);opacity:1}75%{opacity:1}100%{transform:scale(1.15);opacity:0}}
        @keyframes btRays{to{transform:rotate(360deg)}}
        @keyframes btConf{0%{transform:translateY(-20px) rotate(0);opacity:1}100%{transform:translateY(112vh) rotate(560deg);opacity:0}}
        @keyframes btWinText{0%{transform:scale(2.4);opacity:0}45%{transform:scale(1);opacity:1}100%{transform:scale(1);opacity:1}}
        @keyframes btWinJump{0%,100%{transform:translateY(0)}30%{transform:translateY(-22px)}55%{transform:translateY(-4px)}70%{transform:translateY(-12px)}}
        @keyframes btLoseText{0%{transform:scale(1.5);opacity:0}50%{opacity:1}100%{opacity:1}}
      `}</style>
      {showEquip && <EquipModal child={child} data={data} update={update} onClose={()=>setShowEquip(false)}/>}
      {showSeason && <FamilyBattleSeason child={child} data={data} update={update} onClose={()=>setShowSeason(false)}/>}
      {/* 敵の物語ポップ */}
      {enemyInfo && (
        <div onClick={()=>setEnemyInfo(null)} style={{position:"fixed",inset:0,background:"#000a",zIndex:1100,display:"flex",alignItems:"center",justifyContent:"center",padding:24,fontFamily:F}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#141226",border:`2px solid ${enemyInfo.color}`,borderRadius:20,padding:"22px 20px",maxWidth:340,width:"100%",textAlign:"center",boxShadow:`0 0 30px ${enemyInfo.color}80`}}>
            <img src={`/assets/${enemyInfo.img}.png`} style={{width:84,height:84,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent=enemyInfo.emoji;s.style.fontSize="64px";e.target.replaceWith(s);}}/>
            <div style={{fontWeight:900,fontSize:18,color:"#fff",marginTop:6}}>{enemyInfo.name}</div>
            <div style={{fontSize:12,fontWeight:800,color:enemyInfo.color,marginTop:2}}>{enemyInfo.title}・Lv.{enemyInfo.lv}</div>
            <div style={{fontSize:13,color:"rgba(255,255,255,0.82)",lineHeight:1.7,margin:"12px 0",textAlign:"left"}}>{enemyInfo.story}</div>
            <div style={{background:"rgba(74,158,255,0.12)",border:"1px solid rgba(74,158,255,0.35)",borderRadius:12,padding:"10px 12px",fontSize:12.5,color:"#bfe0ff",lineHeight:1.6,textAlign:"left"}}>💡 おかねの まなび<br/>{enemyInfo.lesson}</div>
            <button onClick={()=>setEnemyInfo(null)} style={{marginTop:16,width:"100%",background:enemyInfo.color,border:"none",borderRadius:12,padding:"11px",color:"#fff",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:F}}>とじる</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// お知らせ(新機能のおしらせ)。先頭が最新。idは重複しない文字列に
// ═══════════════════════════════════════════════════════
const NEWS = [
  {id:"n25", e:"🤝", t:"サポートなかま 登場！お手伝いで仲間が増える", b:"今週のお手伝いを3回するたびに「サポートなかま」が1体仲間に（最大3体）。⚔アタッカー（毎ターン敵に追撃）・💚ヒーラー（毎ターンHP回復）・🎲きまぐれ（攻撃か回復をランダム）の3タイプから、その週はランダムで決まるよ。モンスターのレベルが低くても、お手伝いをがんばればバトルを手伝ってくれる＝小さい子も活躍できる！毎週月曜にリセット。"},
  {id:"n24", e:"⚡", t:"素早さ＆ヤミノタマゴ強化が登場！", b:"モンスターに「素早さ(⚡)」ステータスが加わったよ。バトルは素早い方が先に攻撃できる＝先制の有利不利が生まれる！相手選びの画面に「先制できる/敵が先制」も表示。さらに、ヤミノオウを倒して🥚ヤミノタマゴを手に入れるたびに、基礎ステータスが永続+1%アップ（倒すほど強くなる）。みんなの基礎ステータスも少し底上げしたよ。"},
  {id:"n23", e:"⚔", t:"モンスター固有のレア武器＆ドロップ図鑑！", b:"モンスターを倒すと、それぞれ固有のレア武器を低確率でドロップするようになったよ（スライムソード〜ヤミノツルギ）。『記録』タブの「ドロップ図鑑」で、どのモンスターが何を落とすか・集めたかを確認できる。周回してコンプを目指そう！さらにバトルのHPは1分で1回復するようになったよ。"},
  {id:"n22", e:"💰", t:"投資の「配当」がもらえるように！", b:"株を持っていると、毎週ちょっとずつ「配当」がもらえるよ。本物の株とおなじで、配当はそんなに大きくない＆株価が下がれば トータルでは損することもある＝「持てば必ず増える」わけじゃないんだ。だからこそ、すぐ売らずコツコツ長く＆いろんな株に分けて持つのがコツだよ。"},
  {id:"n21", e:"🥚", t:"ヤミノオウのタマゴ 登場！", b:"バトルで「ヤミノオウ」を倒すと、まれに🥚タマゴをドロップ！「記録」タブからお世話すると、たまご→幼年期1→幼年期2→成長期→成熟期→完全体→究極体（じぶんだけの👑ヤミノオウ）と進化するよ。段階が上がるたびに しんか演出！育てきると「ひみつのなかま」で すがたにできる。毎日コツコツお世話するのがポイント！"},
  {id:"n20", e:"✨", t:"こまかい使いやすさ改善！", b:"・ガチャの近くに「きょうのお手伝い数」を表示＝先にお手伝いするとタネがもっと元気に🌱 ・暗い画面の文字を見やすく（コントラスト改善）・記録の「取り消し」はまちがい防止で2タップ確認に・プレミア装備は一度 解放したら、貯金を使っても外れません・バトルのかけら計算など こまかいバグを修正しました。"},
  {id:"n19", e:"💎", t:"プレミア装備が貯金で手に入る！", b:"これまで「近日登場」だったプレミア装備が、貯金や目標達成で解放できるようになったよ！「⚡いかずちの剣」=貯金500pt、「🐉りゅうおうの剣」=目標3回達成、「💎ダイヤのよろい」=貯金1000pt、「🌈にじのオーラ」=目標5回達成。コツコツ貯めるほど 最強そうびに近づくよ。あと、毎日ミッションの「ガチャ」が「まめちしき」に変わって、お金の勉強でEXPがもらえるようになりました。"},
  {id:"n18", e:"📈", t:"投資が やさしくなった！", b:"株の手数料を10%→2%、為替を往復4%→1%に下げました。配当は毎週ちょっとずつ（控えめ）。株価が下がれば損することもある＝「持てば必ず増える」わけじゃない、本物の投資の考え方を体験できるよ。短期で売り買いすると手数料で損しやすいので、コツコツ長く＆分けて持つのがコツ。損益は『今売ったら戻るpt』で正直に表示。"},
  {id:"n17", e:"🆙", t:"レベルのバランス調整", b:"お手伝いのEXPは「同じタスクを連打すると だんだん減る・1日の上限あり」に調整しました。いろんなお手伝いを1回ずつやるのが いちばん効率よくレベルUP！"},
  {id:"n16", e:"⭐", t:"装備にレア度＆プレミア登場！", b:"そうびに レア度（N〜UR）がついたよ。強さとレア度は別！さらに「⚡いかずちの剣」「🐉りゅうおうの剣」「💎ダイヤのよろい」「🌈にじのオーラ」など プレミア装備が図鑑に追加（近日 手に入るように！）。あと、お手伝いでもらえるEXPが ポイント×1.5に！クリアするほど どんどんレベルUP。"},
  {id:"n15", e:"🎒", t:"そうびが2スロット＆図鑑に！", b:"「⚔ぶき」と「🛡たて」を2つ同時に装備できるように！そうびは図鑑になって、お手伝い・連続・バトル、そして“まれにドロップ”でも集まるよ。バトルで勝つと たまに💊回復アイテムや そうびが見つかる！HPはポイントでも回復できる。"},
  {id:"n14", e:"🗺", t:"旅先がえらべるように！", b:"とっくんの旅は「近くの森・海辺・山・遺跡・天空の島・まおうの城」から選べるよ。遠い旅先ほど 時間はかかるけどEXPがたくさん！レベルが上がると新しい旅先が解放。バトルも、強い敵ほど もらえるEXPが多い（選ぶ画面に表示）。"},
  {id:"n13", e:"🧭", t:"とっくんの旅 登場！", b:"ホームの「🧭とっくんの旅」からモンスターを旅に出すと、時間が経つとEXP（ときどき🧩かけらも）がもらえるよ。放置でコツコツ育てよう！"},
  {id:"n12", e:"🎯", t:"きょうのミッション登場！", b:"毎日の「お手伝い3回・なでなで・ガチャ・バトル1勝」をクリアでEXP！ぜんぶ達成すると🧩チケットのかけらももらえるよ。ホーム上部に出ます。"},
  {id:"n11", e:"🎒", t:"そうび（アイテム）登場！", b:"バトル画面の「🎒そうび」から、ぼうし・たて・つるぎ などを装備してステータスUP！レベル・お手伝い・なでなで・連続・バトル勝利など、いろんな がんばりで新しいそうびが解放されるよ。"},
  {id:"n10", e:"🧩", t:"バトル報酬が「チケットのかけら」に", b:"バトルに勝つと「ガチャチケットのかけら」がもらえるよ。5枚あつめると🎟ガチャチケット1枚に！同じモンスターからは1日1かけらまで（でもEXPは毎回もらえる）。いろんな相手と戦って集めよう！"},
  {id:"n09", e:"🆙", t:"モンスターに レベル登場！", b:"お手伝い・なでなで・バトル勝利で EXP が貯まって レベルアップ！レベルが上がると HP・こうげき・ぼうぎょ が強くなるよ。個体値(才能)が高い子ほど ぐんぐん伸びる！"},
  {id:"n08", e:"⚔", t:"モンスターバトル＆ボス登場！", b:"育てたモンスターで野生モンスターとバトル！「⚔モンスターバトル」ボタンから。3ターン勝負で、勝つと🎟ガチャチケットがもらえてガチャをもう1回引けるよ。ヌシ・ドラゴに勝つと秘密のボスも出現！"},
  {id:"n07", e:"❤", t:"バトルはHPを持ち越し", b:"バトルで減ったHPは、お手伝い・なでなで で回復するよ。つかれてると戦えないので、お世話してあげよう（あさになると元気に！）。"},
  {id:"n06", e:"💩", t:"怠けもんに気をつけて", b:"24時間 なでなでも タスクもしないと、モンスターが一時的に「怠けもん」に変身…！なでなでか タスク1つで すぐ元に戻るよ（進化や 育てた度は 消えません）。毎日 かまってあげてね。"},
  {id:"n05", e:"🐾", t:"ひみつのなかま 8体追加", b:"記録タブの「ひみつのなかま」に、コインリス・ブタコ・まねきネコ など8体を追加。たくさんクリアすると解放され、タップで“すがた”を変えられるよ。"},
  {id:"n04", e:"🎨", t:"アプリのアイコンがドット絵に", b:"ホームの統計や見出しのアイコンを、オリジナルのドット絵に変更中。メンバー編集から“ドット絵アバター”も選べます。"},
  {id:"n03", e:"📅", t:"おてつだいが 平日/休日タブに", b:"毎日のおてつだいを、平日／休日のタブで切り替えられるようになりました。今日に合うタブが自動で開きます。"},
  {id:"n02", e:"🎰", t:"ガチャに確定演出＆新シリーズ", b:"SR以上で水やりの瞬間に流れ星・オーロラなどの予兆演出が出るように。図鑑に「世界のお金」シリーズも追加！"},
  {id:"n01", e:"🖼", t:"背景きせかえ追加", b:"累計クリアで、海・夕焼け・夜空・宇宙・オーロラ・桜・森 などの背景が解放されます。"},
];
// デイリーミッション(毎日リセット)。クリアでEXP、全クリアで🧩かけら
const MISSIONS = [
  {id:"m_task",   e:"✅", label:"お手伝いを 3かい", goal:3, metric:"tasks",  exp:10},
  {id:"m_care",   e:"🤚", label:"モンスターを なでなで", goal:1, metric:"care", exp:8},
  {id:"m_learn",  e:"💡", label:"まめちしきを 読む", goal:1, metric:"learn", exp:8},
  {id:"m_battle", e:"⚔", label:"バトルに 1かい かつ", goal:1, metric:"battle", exp:12},
];
// とっくんの旅先(レベルで解放・遠いほど時間とEXP大)
const EXPEDITIONS = [
  {id:"forest",  name:"近くの森",     e:"🌳", mins:30,  exp:25,  frag:0.25, needLv:1},
  {id:"beach",   name:"きらめく海辺", e:"🏖", mins:60,  exp:45,  frag:0.35, needLv:3},
  {id:"mountain",name:"たかい山おく", e:"⛰", mins:90,  exp:75,  frag:0.45, needLv:6},
  {id:"ruins",   name:"ふしぎな遺跡", e:"🏛", mins:120, exp:110, frag:0.55, needLv:10},
  {id:"sky",     name:"天空の島",     e:"☁", mins:150, exp:160, frag:0.7,  needLv:16},
  {id:"castle",  name:"まおうの城",   e:"🏰", mins:180, exp:230, frag:0.9,  needLv:25},
];
// 敵を倒したときのEXP(強いほど多い)
const battleExp = (opp)=> opp.boss ? 70 : 10 + opp.lv*4;
function ExpeditionModal({child,data,update,onClose}){
  const lv=monLevel((data.monsterExp||{})[child.id]||0).lv;
  const go=(id)=>{ update(d=>({...d,expedition:{...(d.expedition||{}),[child.id]:{start:new Date().toISOString(),dest:id}}})); onClose(); };
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:1200,background:"rgba(8,6,18,.6)",display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}}>
      <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:480,maxHeight:"84vh",background:BG,borderRadius:"22px 22px 0 0",display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"16px 18px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}>
          <span style={{fontWeight:900,fontSize:17,color:TEXT}}>🧭 とっくんの旅先</span>
          <button onClick={onClose} style={{background:CARDS,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,padding:"6px 12px",fontWeight:800,cursor:"pointer",fontFamily:F}}>とじる</button>
        </div>
        <div style={{padding:"4px 16px 6px",fontSize:12,color:TEXTS}}>遠い旅先ほど 時間はかかるけど EXPがたくさん！（レベルで解放）</div>
        <div style={{overflowY:"auto",padding:"8px 16px calc(20px + env(safe-area-inset-bottom))"}}>
          {EXPEDITIONS.map(ex=>{
            const ok=lv>=ex.needLv;
            return <div key={ex.id} style={{background:CARD,border:`2px solid ${ok?P+"55":BORDER}`,borderRadius:14,padding:"11px 13px",marginBottom:9,display:"flex",alignItems:"center",gap:12,opacity:ok?1:0.6}}>
              <div style={{fontSize:30,flexShrink:0,filter:ok?"none":"grayscale(1) brightness(.7)"}}>{ex.e}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:800,fontSize:14,color:TEXT}}>{ok?ex.name:"？？？"}</div>
                <div style={{fontSize:11,color:TEXTS,marginTop:2}}>⏱ {ex.mins>=60?`${ex.mins/60}時間`:`${ex.mins}分`} ・ 🆙 EXP+{ex.exp} ・ 🧩{Math.round(ex.frag*100)}%</div>
                {!ok&&<div style={{fontSize:11,color:MUTED,marginTop:2}}>🔒 レベル{ex.needLv}で 解放</div>}
              </div>
              {ok&&<button onClick={()=>go(ex.id)} style={{background:P,border:"none",borderRadius:10,padding:"8px 14px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F,flexShrink:0}}>旅にだす</button>}
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}
function NewsModal({onClose}){
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:1100,background:"rgba(8,6,18,.6)",backdropFilter:"blur(2px)",display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}}>
      <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:480,maxHeight:"82vh",background:BG,borderRadius:"22px 22px 0 0",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 -8px 30px rgba(0,0,0,.3)"}}>
        <div style={{padding:"16px 18px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}>
          <span style={{fontWeight:900,fontSize:17,color:TEXT}}>📢 おしらせ</span>
          <button onClick={onClose} style={{background:CARDS,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,padding:"6px 12px",fontWeight:800,cursor:"pointer",fontFamily:F}}>とじる</button>
        </div>
        <div style={{overflowY:"auto",padding:"12px 16px calc(20px + env(safe-area-inset-bottom))"}}>
          {NEWS.map((n,i)=>(
            <div key={n.id} style={{background:CARD,border:`1.5px solid ${i===0?G:BORDER}`,borderRadius:16,padding:"13px 14px",marginBottom:10,display:"flex",gap:11}}>
              <div style={{fontSize:26,flexShrink:0}}>{n.e}</div>
              <div style={{flex:1}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontWeight:900,fontSize:14,color:TEXT}}>{n.t}</span>
                  {i===0&&<span style={{fontSize:10,fontWeight:900,color:"#fff",background:R,borderRadius:999,padding:"1px 6px"}}>NEW</span>}
                </div>
                <div style={{fontSize:12.5,color:TEXTS,lineHeight:1.6,marginTop:4}}>{n.b}</div>
              </div>
            </div>
          ))}
          <div style={{textAlign:"center",color:MUTED,fontSize:11,marginTop:6}}>🌱 Tane Money は どんどん あたらしくなるよ</div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// DAILY TASKS
// ═══════════════════════════════════════════════════════
function DailyTasks({ child, data, update }) {
  const today  = todayKey();
  // アクティブセットを取得（最大2セットを同時に。期間チェック・null安全）
  const sets = data.dailyTaskSets || [];
  const _todayISO = todayISO();
  const inWindow = s => !!s && s.active!==false &&
    (!s.startDate || _todayISO >= s.startDate) && (!s.endDate || _todayISO <= s.endDate);
  const activeSets = (() => {
    try {
      if (sets.length === 0) return [];
      const ids = (Array.isArray(data.activeSetIds) && data.activeSetIds.length)
        ? data.activeSetIds : (data.activeSetId ? [data.activeSetId] : []);
      let chosen = ids.map(id => sets.find(s => s.id === id)).filter(inWindow);
      if (chosen.length === 0) {
        const fb = sets.find(inWindow) || sets.find(s => s.active!==false) || sets[0];
        chosen = fb ? [fb] : [];
      }
      return chosen.slice(0, 4);
    } catch(e) { return []; }
  })();
  const activeSet = activeSets[0] || null;   // 後方互換(ヘッダ表示等)
  // 平日/休日タブ: 1セットずつ表示。今日に合うセットを自動選択(手動でも切替可)
  const _isWeekend = [0,6].includes(new Date().getDay());
  const _pickToday = () => {
    const wk  = activeSets.find(s=>(s.name||"").includes("平日"));
    const hol = activeSets.find(s=>/休|週末|土日/.test(s.name||""));
    return ((_isWeekend ? (hol||wk) : (wk||hol)) || activeSets[0] || {}).id || null;
  };
  const [selSetId, setSelSetId] = useState(null);
  const selId   = (selSetId && activeSets.some(s=>s.id===selSetId)) ? selSetId : _pickToday();
  const viewSet = activeSets.find(s=>s.id===selId) || activeSets[0] || null;
  // 完了キーは「セットID::タスクID」で名前空間化(ID衝突回避)
  const tasks = viewSet
    ? (Array.isArray(viewSet.tasks)?viewSet.tasks:[]).map(t =>
        ({...t, _k:`${viewSet.id}::${t.id}`, _setId:viewSet.id, _setName:viewSet.name, _setEmoji:viewSet.emoji}))
    : (data.dailyTasks || []).map(t => ({...t, _k:t.id, _setId:"", _setName:"", _setEmoji:""}));
  const bonusTotal = viewSet ? (viewSet.bonus??0) : (data.dailyBonus??50);
  const prog   = (data.dailyProgress?.[child.id]?.[today]) || {};
  const [flash, setFlash] = useState(null);
  const [justDone, setJustDone] = useState({});
  const [combo, setCombo] = useState(0);
  const [openOverride, setOpenOverride] = useState(null);   // null=自動(未完で開く/完了で畳む), true/false=手動
  const comboTimer = useRef(null);
  const totalDoneMon = (data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")).length;
  const _rawMonStage = ((data.monsterEvolved||{})[child.id]) || "egg";
  const monStageId = MONSTER_TREE[_rawMonStage] ? _rawMonStage : "egg";
  // 背景テーマ解決（累計タスクで解放。未解放/autoならデフォルト時間帯背景）
  const _bgTid = (data.bgTheme||{})[child.id] || "auto";
  const _bgTheme = BG_THEMES.find(t=>t.id===_bgTid) || BG_THEMES[0];
  const _bgUnlocked = (_bgTheme.need||0) <= totalDoneMon;
  const heroGrad = (_bgUnlocked && _bgTheme.grad) ? _bgTheme.grad : null;
  const heroImg  = (_bgUnlocked && _bgTheme.img) ? _bgTheme.img : null;
  const heroStars = _bgUnlocked && _bgTheme.stars;

  const showFlash = (pts, emoji) => { setFlash({pts,emoji}); setTimeout(()=>setFlash(null),1100); };
  const markJustDone = id => {
    setJustDone(p=>({...p,[id]:true}));
    setTimeout(()=>setJustDone(p=>{const n={...p};delete n[id];return n;}),550);
    setCombo(c=>c+1);
    if(comboTimer.current) clearTimeout(comboTimer.current);
    comboTimer.current=setTimeout(()=>setCombo(0),3000);
  };

  const isCheck   = t => t.type === "check";
  const isDone    = t => isCheck(t) ? !!prog[t._k] : (prog[t._k]||0) >= (t.target||1);
  const doneCount = tasks.filter(t => isDone(t)).length;
  const allDone   = doneCount === tasks.length && tasks.length > 0;
  // セット単位の完了/ボーナス判定(2セットそれぞれに全達成ボーナス)
  const bonusKey  = s => `__bonus__::${s.id}`;
  const setDoneIn = (s, p) => (Array.isArray(s.tasks)?s.tasks:[]).every(tt =>
    tt.type==="check" ? !!p[`${s.id}::${tt.id}`] : (p[`${s.id}::${tt.id}`]||0) >= (tt.target||1));
  const allBonusGiven = viewSet ? (!viewSet.bonus || !!prog[bonusKey(viewSet)]) : true;
  // 開閉: 既定は「未完なら開く・全部できたら畳む」。タップで手動上書き。
  const open = openOverride !== null ? openOverride : !allDone;
  const toggleOpen = () => setOpenOverride(!open);

  const mkEntry = (label, pts) => ({ id:uid(), cid:child.id, type:"daily", label, pts, date:new Date().toISOString() });
  const setDailyProg = (d, extra) => ({
    ...d,
    dailyProgress: {
      ...d.dailyProgress,
      [child.id]: { ...(d.dailyProgress?.[child.id]||{}), [today]: { ...((d.dailyProgress?.[child.id]?.[today])||{}), ...extra } }
    }
  });

  // 該当セットが全部終わったら、そのセットのボーナスを付与(1回だけ)
  const awardSetBonus = (setId, newProg) => {
    const s = activeSets.find(x => x.id === setId);
    if (!s || !s.bonus || s.bonus <= 0) return;
    if (prog[bonusKey(s)]) return;
    if (!setDoneIn(s, newProg)) return;
    setTimeout(() => {
      const bonusEntry = mkEntry(`🌟 ${s.name} ぜんぶ達成ボーナス！`, s.bonus);
      update(d => ({ ...setDailyProg(d, {[bonusKey(s)]:true}), logs:[bonusEntry,...d.logs] }));
      addLogToFirestore(bonusEntry);
      setFlash({ pts:s.bonus, emoji:"🌟" });
      setTimeout(()=>setFlash(null),1400);
    }, 600);
  };

  const handleCheck = t => {
    if (isDone(t)) return;
    showFlash(t.pts, t.emoji);
    markJustDone(t._k);
    const entry = mkEntry(`✅ ${t.label}`, t.pts);
    update(d => careCap({ ...setDailyProg(d, {[t._k]:true}), logs:[entry,...d.logs] }, child.id, 0.2, Math.max(1,t.pts*1.5)));
    addLogToFirestore(entry);
    awardSetBonus(t._setId, { ...prog, [t._k]: true });
  };

  const handleCount = t => {
    const cur = prog[t._k] || 0;
    if (cur >= (t.target||1) && isDone(t)) return;
    const nxt = cur + 1;
    showFlash(t.pts, t.emoji);
    if(nxt>=(t.target||1)) markJustDone(t._k);
    const entry = mkEntry(`🔢 ${t.label}（${nxt}回目）`, t.pts);
    update(d => careCap({ ...setDailyProg(d, {[t._k]:nxt}), logs:[entry,...d.logs] }, child.id, 0.12, Math.max(1, t.pts*(nxt===1?1.5:nxt===2?0.6:0.2))));
    addLogToFirestore(entry);
    if (nxt>=(t.target||1)) awardSetBonus(t._setId, { ...prog, [t._k]: nxt });
  };

  return (
    <div style={{padding:"12px 16px",paddingBottom:0}}>
      {flash && (
        <div style={{position:"fixed",top:"28%",left:"50%",transform:"translate(-50%,-50%)",background:flash.pts>=0?G:R,color:"#fff",borderRadius:20,padding:"13px 24px",zIndex:900,textAlign:"center",animation:"popIn .3s ease"}}>
          <div style={{fontSize:36}}>{flash.emoji}</div>
          <Yen v={flash.pts} sz={20}/>
          {flash.pts>0&&<>
            <img src={`/assets/monster_${monStageId}_f0.png`} style={{width:48,height:48,objectFit:"contain",display:"block",margin:"5px auto 2px",imageRendering:"pixelated",animation:"heartbeat .6s ease-in-out"}} onError={e=>{e.target.style.display="none"}}/>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.9)"}}>✨ なかまがよろこんだ！</div>
          </>}
          {combo>=3&&<div style={{fontSize:13,fontWeight:900,color:"#fde68a",marginTop:4}}>🔥 {combo}コンボ！</div>}
        </div>
      )}

      {/* Progress bar（タップで下のタスク一覧を開閉するヘッダー） */}
      <div onClick={toggleOpen} role="button" style={{background:CARD,border:`2px solid ${allDone?"#34c77b":BORDER}`,borderRadius:18,padding:16,marginBottom:14,cursor:"pointer",userSelect:"none"}}>
        {/* 平日/休日タブ(2セット以上で切替・タップで選択。今日に合うセットを自動選択) */}
        {activeSets.length>1 ? (
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
            {activeSets.map(s=>{const sel=s.id===selId;const sdone=setDoneIn(s,prog);return(
              <button key={s.id} onClick={(e)=>{e.stopPropagation();setSelSetId(s.id);}}
                style={{display:"inline-flex",alignItems:"center",gap:4,background:sel?GP:`${P}10`,border:`1.5px solid ${sel?GP:"transparent"}`,borderRadius:999,padding:"5px 13px",cursor:"pointer",fontFamily:F}}>
                <span style={{fontSize:14}}>{s.emoji}</span>
                <span style={{fontWeight:800,fontSize:12,color:sel?"#fff":P}}>{s.name}</span>
                {sdone&&<span style={{fontSize:11,fontWeight:900,color:sel?"#fff":G}}>✓</span>}
              </button>);})}
          </div>
        ) : activeSets.length===1 ? (
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{display:"inline-flex",alignItems:"center",gap:4,background:`${P}12`,borderRadius:10,padding:"2px 8px"}}>
              <span style={{fontSize:14}}>{activeSets[0].emoji}</span>
              <span style={{fontWeight:800,fontSize:11,color:P}}>{activeSets[0].name}</span>
            </span>
          </div>
        ) : null}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <p style={{fontWeight:900,fontSize:14,margin:0,color:allDone?G:TEXT}}>
            {allDone ? "🌟 今日は全部できた！" : "📋 今日のやること"}
          </p>
          <span style={{fontWeight:800,fontSize:13,color:allDone?G:MUTED,display:"flex",alignItems:"center",gap:6}}>
            {doneCount}/{tasks.length}
            <span style={{fontSize:11,opacity:.7,transition:"transform .25s",transform:open?"rotate(0deg)":"rotate(-90deg)"}}>▼</span>
          </span>
        </div>
        <div style={{height:10,background:BORDER,borderRadius:5,overflow:"hidden",marginBottom:8}}>
          <div style={{height:"100%",width:`${tasks.length?doneCount/tasks.length*100:0}%`,background:allDone?G:Y,borderRadius:5,transition:"width .5s ease"}}/>
        </div>
        {bonusTotal>0 && (
          <p style={{color:allBonusGiven?G:MUTED,fontSize:12,fontWeight:700,margin:0}}>
            {allBonusGiven ? `✅ ボーナス +${bonusTotal}pt もらえた！` : `🎁 ぜんぶやると +${bonusTotal}pt ボーナス！`}
          </p>
        )}
        {tasks.length===0&&<p style={{color:MUTED,fontSize:12,margin:"8px 0 0"}}>アクティブなタスクセットがないよ</p>}
      </div>

      {/* Task list（開いているときだけ表示。セットごとに見出しを付けて2セットまとめ表示） */}
      {open && <>
      {tasks.length === 0 && (
        <p style={{color:MUTED,textAlign:"center",fontSize:13,marginTop:20}}>まだデイリータスクがないよ</p>
      )}
      {tasks.map((t,i) => {
        const done = isDone(t);
        const count = isCheck(t) ? null : (prog[t._k]||0);
        const showHeader = false; // 平日/休日はタブで切替表示するため、一覧内の見出しは不要
        return (
          <React.Fragment key={t._k}>
          {showHeader&&(
            <div style={{display:"flex",alignItems:"center",gap:6,margin:"6px 2px 8px",paddingTop:i===0?0:6}}>
              <span style={{fontSize:15}}>{t._setEmoji}</span>
              <span style={{fontWeight:800,fontSize:12,color:P}}>{t._setName}</span>
              <div style={{flex:1,height:1,background:BORDER}}/>
            </div>
          )}
          <div
            style={{background:done?"#e8faf0":CARD, border:`2px solid ${done?G:BORDER}`, borderRadius:16, padding:"14px 16px", marginBottom:10, display:"flex", alignItems:"center", gap:12, transition:"all .25s", transform:justDone[t._k]?"scale(1.08)":"scale(1)", boxShadow:justDone[t._k]?`0 0 0 4px ${G}90`:"none"}}>
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
          </React.Fragment>
        );
      })}
      </>}
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


// prompt()の代替：モバイルでも崩れない自前の入力モーダル付きボタン（自己完結）
function PromptModalButton({ btnStyle, btnLabel, title, desc, type, maxLen, initial, placeholder, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(initial||"");
  return (
    <>
      <button onClick={()=>{ setV(initial||""); setOpen(true); }} style={btnStyle}>{btnLabel}</button>
      {open && (
        <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,background:"#000a",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:24,fontFamily:F}}>
          <div onClick={e=>e.stopPropagation()} style={{background:CARD,borderRadius:20,padding:"24px 22px",width:"100%",maxWidth:340,boxShadow:"0 12px 48px #0005"}}>
            <div style={{fontWeight:900,fontSize:17,color:TEXT,marginBottom:desc?6:14}}>{title}</div>
            {desc&&<div style={{fontSize:13,color:MUTED,marginBottom:14,lineHeight:1.6}}>{desc}</div>}
            <input autoFocus value={v}
              onChange={e=>{const raw=e.target.value; setV(type==="number"?raw.replace(/[^0-9]/g,"").slice(0,maxLen||6):raw.slice(0,maxLen||40));}}
              type="text" inputMode={type==="number"?"numeric":"text"} placeholder={placeholder||""}
              style={{width:"100%",padding:"13px 14px",border:`2px solid ${BORDER}`,borderRadius:12,fontSize:18,fontWeight:700,fontFamily:F,background:BG,outline:"none",textAlign:"center",letterSpacing:type==="number"?6:1,boxSizing:"border-box",marginBottom:16}}/>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setOpen(false)} style={{flex:1,padding:"13px",background:"transparent",border:`1.5px solid ${BORDER}`,borderRadius:12,color:MUTED,fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>キャンセル</button>
              <button onClick={()=>{ const val=v; setOpen(false); onSubmit(val); }} style={{flex:1.4,padding:"13px",background:GP,border:"none",borderRadius:12,color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>けってい</button>
            </div>
          </div>
        </div>
      )}
    </>
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
  const [smEditReward, setSmEditReward] = useState(null);
  const [smAddOpen, setSmAddOpen] = useState(false);
  const [smREmoji, setSmREmoji] = useState("🎁");
  const [smRLabel, setSmRLabel] = useState("");
  const [smRCost, setSmRCost] = useState("5");
  const [smRUnit, setSmRUnit] = useState("");

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
      if(parentPinMatches(next, data)) {
        setTimeout(()=>{
          setAuthed(true);
          if(parentPinIsDefault(data)){ setSettingsGroup("adv"); setSettingsTab("members"); }
        }, 200);
      } else {
        setTimeout(()=>{setPinErr(true);setPin("");}, 300);
      }
    }
  };

  const QUICK_TABS = [["grant","🎁 pt付与"],["approval","✅ 承認"]];
  const ADV_TABS   = [["tasks","📋 タスク"],["assign","👤 割当"],["rewards","🎁 特典"],["interest","💹 利子"],["family","🏆 家族目標"],["members","🔐 PIN"],["transfer","🔄 引継"]];
  const SETTING_TABS = settingsGroup==="quick" ? QUICK_TABS : ADV_TABS;

  if(!authed) return (
    <div style={{position:"fixed",inset:0,background:"#000a",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      <div style={{background:CARD,borderRadius:24,padding:"32px 24px",width:"100%",maxWidth:320,textAlign:"center",boxShadow:"0 8px 40px #0004"}}>
        <div style={{fontSize:44,marginBottom:8}}>🔐</div>
        <h3 style={{fontWeight:900,fontSize:18,color:TEXT,margin:"0 0 4px"}}>設定・管理</h3>
        <p style={{color:MUTED,fontSize:12,margin:"0 0 12px"}}>おや用PIN（初期：0000）</p>
        {parentPinIsDefault(data)&&(
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
            <h3 style={{fontWeight:900,fontSize:18,color:TEXT,margin:"0 0 2px"}}><Ico name="gear" fb="⚙" size={17} style={{marginRight:5}}/>全体管理</h3>
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
              {l}{v==="approval"&&((data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length)>0&&<span style={{marginLeft:5,background:R,color:"#fff",borderRadius:999,padding:"0 5px",fontSize:11,fontWeight:900}}>{(data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length}</span>}
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
                          if(!txGuard("grant_"+member.id)) return;   // 連打ガード(二重付与防止)
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
                          if(!txGuard("deduct_"+member.id)) return;   // 連打ガード(二重減算防止)
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
                                <div style={{color:MUTED,fontSize:11}}>+{t.pts}pt</div>
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
                <div key={r.id}>
                  {smEditReward?.id===r.id ? (
                    <div style={{background:BG,border:`1.5px solid ${B}`,borderRadius:12,padding:"12px 14px",marginBottom:8}}>
                      <div style={{display:"flex",gap:6,marginBottom:6}}>
                        <input value={smEditReward.emoji} onChange={e=>setSmEditReward(v=>({...v,emoji:e.target.value}))} style={{...INP,width:52,textAlign:"center"}}/>
                        <input value={smEditReward.label} onChange={e=>setSmEditReward(v=>({...v,label:e.target.value}))} placeholder="特典名" style={INP}/>
                      </div>
                      <input value={smEditReward.cost} onChange={e=>setSmEditReward(v=>({...v,cost:e.target.value}))} type="number" placeholder="必要pt" style={{...INP,marginBottom:6}}/>
                      <input value={smEditReward.unit} onChange={e=>setSmEditReward(v=>({...v,unit:e.target.value}))} placeholder="内容説明（例: 30分延長）" style={{...INP,marginBottom:10}}/>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>{
                          const cost=parseInt(smEditReward.cost);
                          if(!smEditReward.label||isNaN(cost)||cost<=0)return;
                          update(d=>({...d,rewards:d.rewards.map(x=>x.id===smEditReward.id?{...smEditReward,cost}:x)}));
                          setSmEditReward(null);
                        }} style={{flex:1,padding:"8px",background:G,border:"none",borderRadius:10,color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>保存</button>
                        <button onClick={()=>setSmEditReward(null)} style={{flex:1,padding:"8px",background:BORDER,border:"none",borderRadius:10,color:MUTED,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>キャンセル</button>
                      </div>
                    </div>
                  ):(
                    <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                      {/^r0\d$/.test(r.id)?<img src={`/assets/reward_${r.id}.png`} style={{width:30,height:30,objectFit:"contain",borderRadius:6,flexShrink:0}} alt=""/>:<span style={{fontSize:22}}>{r.emoji}</span>}
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13}}>{r.label}</div>
                        <div style={{color:MUTED,fontSize:11}}>{r.cost}pt · {r.unit}</div>
                      </div>
                      <button onClick={()=>setSmEditReward({...r,cost:String(r.cost)})}
                        style={{padding:"4px 10px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:8,color:B,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,marginRight:4}}>編集</button>
                      <button onClick={()=>update(d=>({...d,rewards:d.rewards.filter(x=>x.id!==r.id)}))}
                        style={{padding:"4px 10px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:8,color:R,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>削除</button>
                    </div>
                  )}
                </div>
              ))}
              {smAddOpen ? (
                <div style={{background:BG,border:`1.5px solid ${G}`,borderRadius:12,padding:"12px 14px",marginBottom:8}}>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>
                    <input value={smREmoji} onChange={e=>setSmREmoji(e.target.value)} style={{...INP,width:52,textAlign:"center"}}/>
                    <input value={smRLabel} onChange={e=>setSmRLabel(e.target.value)} placeholder="特典名" style={INP}/>
                  </div>
                  <input value={smRCost} onChange={e=>setSmRCost(e.target.value)} type="number" placeholder="必要pt（例: 5）" style={{...INP,marginBottom:6}}/>
                  <input value={smRUnit} onChange={e=>setSmRUnit(e.target.value)} placeholder="内容説明（例: 1回）" style={{...INP,marginBottom:10}}/>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{
                      const cost=parseInt(smRCost);
                      if(!smRLabel||isNaN(cost)||cost<=0)return;
                      update(d=>({...d,rewards:[...d.rewards,{id:uid(),emoji:smREmoji,label:smRLabel,cost,unit:smRUnit||"1回"}]}));
                      setSmRLabel("");setSmREmoji("🎁");setSmRCost("5");setSmRUnit("");setSmAddOpen(false);
                    }} style={{flex:1,padding:"8px",background:G,border:"none",borderRadius:10,color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>追加</button>
                    <button onClick={()=>setSmAddOpen(false)} style={{flex:1,padding:"8px",background:BORDER,border:"none",borderRadius:10,color:MUTED,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>キャンセル</button>
                  </div>
                </div>
              ):(
                <button onClick={()=>setSmAddOpen(true)}
                  style={{width:"100%",padding:"12px",background:`${G}15`,border:`2px dashed ${G}`,borderRadius:12,color:G,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                  ＋ 新しいご褒美を追加
                </button>
              )}
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
                      <Emo e={m.emoji} size={18}/>
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

          {settingsTab==="members"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>メンバーとPIN管理</p>
              {[{id:"parent",name:"おや管理",emoji:"🔐",isParent:true},...data.children,(data.parents||[])].flat().filter((x,i,a)=>x&&a.findIndex(y=>y&&y.id===x.id)===i).map(m=>{
                if(!m) return null;
                return(
                  <div key={m.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                    <Emo e={m.emoji} size={24}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13}}>{m.name}</div>
                      <div style={{color:MUTED,fontSize:11}}>PIN: {'*'.repeat(4)}</div>
                    </div>
                    <PromptModalButton btnLabel="PIN変更" title={`${m.name}の あたらしい PIN`} desc="4けたの すうじを いれてね" type="number" maxLen={4} placeholder="0000"
                      btnStyle={{padding:"6px 12px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:8,color:B,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}
                      onSubmit={(np)=>{
                        if(!np||np.length!==4){alert("4桁の数字を入力してください");return;}
                        if(m.isParent||m.id==="parent") update(d=>{const{parentPin,...rest}=d;return{...rest,parentPinH:pinHash(np)};});
                        else update(d=>({...d,children:d.children.map(c=>c.id===m.id?(({pin,...r})=>({...r,pinh:pinHash(np)}))(c):c),parents:(d.parents||[]).map(p=>p.id===m.id?(({pin,...r})=>({...r,pinh:pinHash(np)}))(p):p),pinChanged:{...(d.pinChanged||{}),[m.id]:true}}));
                      }}/>
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
                <p style={{color:MUTED,fontSize:11,margin:"0 0 10px"}}>このコードを家族に共有してください</p>
                <PromptModalButton btnLabel="🔗 ファミリーコードを変更" title="ファミリーコードを変更" desc="参加したいコードを入力（家族の端末の設定で確認できます）" type="text" maxLen={20} placeholder="TANE-XXXX-XXXX"
                  btnStyle={{width:"100%",padding:"9px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:10,color:B,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,marginBottom:8}}
                  onSubmit={(newCode)=>{
                    if(!newCode)return;
                    const code=newCode.trim().toUpperCase();
                    if(!/^[A-Z0-9\-]{8,20}$/.test(code)){alert("コードの形式が正しくありません（8文字以上の英数字）");return;}
                    if(!confirm(`「${code}」のファミリーに切り替えますか？\n今のファミリーのデータはクラウドに残ります。`))return;
                    try{localStorage.setItem("tane_money_family_code",code);}catch(e){}
                    _familyCode=code;
                    window.location.reload();
                  }}/>
                <button onClick={()=>{
                  if(!confirm("この端末からログアウトしますか？\nファミリーコード入力画面に戻ります。"))return;
                  try{localStorage.removeItem("tane_money_family_code");}catch(e){}
                  _familyCode=null;
                  window.location.reload();
                }} style={{width:"100%",padding:"9px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,color:R,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
                  🚪 この端末からログアウト
                </button>
              </div>
            </div>
          )}

          {/* ── 承認タブ ── */}
          {settingsTab==="approval"&&(()=>{
            const fs=data.familySettings||INIT.familySettings;
            const pending=data.pendingApprovals||[];
            const approve=(entry)=>{
              _processedApprovalIds.add(entry.id);
              const log={id:uid(),cid:entry.cid,type:"good",label:entry.taskLabel,pts:entry.pts,date:new Date().toISOString(),rid:entry.taskId};
              addLogToFirestore(log);
              update(d=>({...d,logs:[log,...d.logs],pendingApprovals:(d.pendingApprovals||[]).filter(p=>p.id!==entry.id)}));
            };
            const reject=(entry)=>{
              _processedApprovalIds.add(entry.id);
              update(d=>({...d,pendingApprovals:(d.pendingApprovals||[]).filter(p=>p.id!==entry.id)}));
            };
            return(<div>
              {/* 承認モード切り替え */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>タスク承認が必要</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>ONにすると、子どものお手伝い記録を親が承認</div>
                </div>
                <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),requireApproval:!fs.requireApproval}}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:fs.requireApproval?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:fs.requireApproval?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* ガチャ演出をシンプルに（暗転・段階成長をOFF） */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>ガチャ演出をシンプルに</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>ONにすると暗転やタメ演出を省いてすぐ結果に（まぶしさ/待ち時間が苦手な子に）</div>
                </div>
                <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),gachaSimple:!(d.familySettings?.gachaSimple)}}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:(fs.gachaSimple)?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:(fs.gachaSimple)?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* ゲームの強さ設定: ガチャ/バトル/旅をどこまで見せるか */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
                <div style={{fontWeight:800,fontSize:14,color:TEXT}}>ゲームの強さ</div>
                <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:10}}>遊びの要素をどこまで出すか選べます。お金の管理に集中させたいときは「ひかえめ」へ。</div>
                {[
                  {v:"full", t:"ぜんぶ", d:"ガチャ・バトル・とっくんの旅をすべて表示（標準）"},
                  {v:"light",t:"バトル控えめ",d:"ガチャと育成はOK。バトル・とっくんの旅を非表示に"},
                  {v:"money",t:"お小遣い帳中心",d:"ガチャ・バトル・旅・ミッションを隠して、お金の記録に集中"},
                ].map(o=>{
                  const sel=(fs.gameMode||"full")===o.v;
                  return (
                    <button key={o.v} onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),gameMode:o.v}}))}
                      style={{display:"flex",alignItems:"flex-start",gap:10,width:"100%",textAlign:"left",background:sel?GS:CARD,border:sel?`2px solid ${GP}`:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 12px",marginBottom:7,cursor:"pointer",fontFamily:F}}>
                      <span style={{marginTop:1,width:18,height:18,borderRadius:"50%",border:sel?`5px solid ${GP}`:`2px solid ${BORDER}`,flexShrink:0,boxSizing:"border-box",background:"#fff"}}/>
                      <span style={{flex:1}}>
                        <span style={{display:"block",fontWeight:800,fontSize:13,color:sel?GP:TEXT}}>{o.t}</span>
                        <span style={{display:"block",fontSize:11,color:MUTED,marginTop:2,lineHeight:1.4}}>{o.d}</span>
                      </span>
                    </button>
                  );
                })}
                {/* 1日のバトル回数(周回しすぎ防止) ※「ぜんぶ」のときだけ有効 */}
                {(fs.gameMode||"full")==="full" && (
                  <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${BORDER}`}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT}}>1日のバトル回数</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:8}}>やりすぎ(周回)が気になるときに上限を設定。とっくんの旅は時間でゆっくり進むので対象外です。</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {[{v:0,t:"なし"},{v:3,t:"3回"},{v:5,t:"5回"},{v:10,t:"10回"}].map(o=>{
                        const sel=((fs.dailyBattleLimit)||0)===o.v;
                        return (
                          <button key={o.v} onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),dailyBattleLimit:o.v}}))}
                            style={{flex:1,minWidth:60,background:sel?GP:CARD,border:sel?`2px solid ${GP}`:`1.5px solid ${BORDER}`,borderRadius:10,padding:"8px 4px",color:sel?"#fff":TEXT,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>{o.t}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              {/* 投資ワールド設定: 投資のON/OFF・為替だけOFF・1日の売買回数(小中向けに親が手綱を握れる) */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
                <div style={{fontWeight:800,fontSize:14,color:TEXT}}>投資ワールド（畑）</div>
                <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:10}}>株や為替の体験を どこまで見せるか。お金はポイントで、実際のお金は動きません。</div>
                {/* 投資ワールド ON/OFF */}
                <div style={{display:"flex",alignItems:"center",gap:12,paddingBottom:10,borderBottom:`1px solid ${BORDER}`}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT}}>投資ワールドを見せる</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2}}>OFFにすると 畑（株・為替）を まるごと非表示に</div>
                  </div>
                  <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),investOff:!(d.familySettings?.investOff)}}))}
                    style={{position:"relative",width:48,height:26,borderRadius:13,background:(!fs.investOff)?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s",flexShrink:0}}>
                    <div style={{position:"absolute",top:3,left:(!fs.investOff)?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                  </button>
                </div>
                {/* 為替だけ OFF (株はOKだが値動きの激しい為替は隠す) */}
                {!fs.investOff && (
                  <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:`1px solid ${BORDER}`}}>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:800,fontSize:13,color:TEXT}}>為替（かわせ）を見せる</div>
                      <div style={{color:MUTED,fontSize:11,marginTop:2}}>為替は値動きが激しめ。株だけにしたいときはOFFに</div>
                    </div>
                    <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),forexOff:!(d.familySettings?.forexOff)}}))}
                      style={{position:"relative",width:48,height:26,borderRadius:13,background:(!fs.forexOff)?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s",flexShrink:0}}>
                      <div style={{position:"absolute",top:3,left:(!fs.forexOff)?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                    </button>
                  </div>
                )}
                {/* 1日の売買回数(張り付き・回転売買の防止) */}
                {!fs.investOff && (
                  <div style={{marginTop:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT}}>1日の売り買い回数</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:8}}>何度も売り買い（回転売買）が気になるときに上限を。投資は「待つ」のが学びです。</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {[{v:0,t:"なし"},{v:1,t:"1回"},{v:3,t:"3回"},{v:5,t:"5回"}].map(o=>{
                        const sel=((fs.dailyTradeLimit)||0)===o.v;
                        return (
                          <button key={o.v} onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),dailyTradeLimit:o.v}}))}
                            style={{flex:1,minWidth:56,background:sel?GP:CARD,border:sel?`2px solid ${GP}`:`1.5px solid ${BORDER}`,borderRadius:10,padding:"8px 4px",color:sel?"#fff":TEXT,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>{o.t}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              {/* 承認通知 */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:fs.approvalNotification?8:16,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>承認通知</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>申請が届いたらブラウザ通知でお知らせ</div>
                  {"Notification" in window && Notification.permission==="denied" && (
                    <div style={{color:R,fontSize:11,marginTop:4}}>通知がブロックされています。ブラウザ設定から許可してください</div>
                  )}
                </div>
                <button onClick={async()=>{
                  if(!fs.approvalNotification){
                    if(!("Notification" in window)) return;
                    const perm = await Notification.requestPermission();
                    if(perm==="granted") update(d=>({...d,familySettings:{...(d.familySettings||{}),approvalNotification:true}}));
                  } else {
                    update(d=>({...d,familySettings:{...(d.familySettings||{}),approvalNotification:false}}));
                  }
                }}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:fs.approvalNotification?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:fs.approvalNotification?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {fs.approvalNotification && "Notification" in window && Notification.permission==="granted" && (
                <div style={{background:GS,border:`1.5px solid ${G}`,borderRadius:12,padding:"10px 14px",marginBottom:16,display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:18}}>✅</span>
                  <div>
                    <div style={{fontWeight:700,fontSize:12,color:GP}}>通知の準備ができました！</div>
                    <div style={{fontSize:11,color:MUTED,marginTop:1}}>子どもが申請するとスマホに通知が届きます</div>
                  </div>
                </div>
              )}
              {/* 交換承認が必要 */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>交換承認が必要</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>ONにすると、報酬の交換を親が承認してからptを消費</div>
                </div>
                <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),rewardApproval:!fs.rewardApproval}}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:fs.rewardApproval?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:fs.rewardApproval?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* タスク承認待ちキュー */}
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 10px"}}>タスク承認待ち（{pending.length}件）</p>
              {pending.length===0&&<div style={{textAlign:"center",padding:"16px 0",color:MUTED,fontSize:13}}>承認待ちのタスクはありません</div>}
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
              {/* 交換承認待ちキュー */}
              {(()=>{
                const pendingR=data.pendingRedemptions||[];
                const approveR=(entry)=>{
                  const log={id:uid(),cid:entry.cid,type:"reward",label:`${entry.rewardLabel}（${entry.rewardUnit}）`,pts:-entry.cost,rid:entry.rewardId,date:new Date().toISOString()};
                  addLogToFirestore(log);
                  update(d=>({...d,logs:[log,...d.logs],pendingRedemptions:(d.pendingRedemptions||[]).filter(p=>p.id!==entry.id)}));
                };
                const rejectR=(entry)=>{
                  update(d=>({...d,pendingRedemptions:(d.pendingRedemptions||[]).filter(p=>p.id!==entry.id)}));
                };
                if(pendingR.length===0) return null;
                return(<>
                  <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"16px 0 10px"}}>交換承認待ち（{pendingR.length}件）</p>
                  {pendingR.map(entry=>{
                    const member=[...data.children,...(data.parents||[])].find(m=>m.id===entry.cid);
                    return(
                      <div key={entry.id} style={{background:PS,border:`1.5px solid ${P}`,borderRadius:14,padding:"12px 14px",marginBottom:10}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                          <span style={{fontSize:26}}>{entry.rewardEmoji}</span>
                          <div style={{flex:1}}>
                            <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{entry.rewardLabel}</div>
                            <div style={{fontSize:11,color:MUTED}}>{member?.name||"?"} · {entry.cost}pt</div>
                          </div>
                        </div>
                        <div style={{display:"flex",gap:8}}>
                          <button onClick={()=>approveR(entry)} style={{flex:1,background:G,border:"none",borderRadius:10,padding:"9px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>✅ 承認</button>
                          <button onClick={()=>rejectR(entry)} style={{flex:1,background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,padding:"9px",color:R,fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>❌ 却下</button>
                        </div>
                      </div>
                    );
                  })}
                </>);
              })()}
            </div>);
          })()}

          {/* ── 家族目標タブ ── */}
          {settingsTab==="family"&&(()=>{
            const fm=data.familySettings?.familyMission||{enabled:true,label:"みんなの活動で 3,000 pt を育てよう",target:3000,reward:"週末に家族でアイスを選ぶ"};
            const setFm=patch=>update(d=>({...d,familySettings:{...(d.familySettings||{}),familyMission:{...(d.familySettings?.familyMission||{enabled:true,label:"みんなの活動で 3,000 pt を育てよう",target:3000,reward:"週末に家族でアイスを選ぶ"}),...patch}}}));
            return(
              <div>
                <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 16px"}}>家族全員で目指す共通ゴールを設定します</p>
                {/* ON/OFF */}
                <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10,display:"flex",alignItems:"center",gap:12}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:800,fontSize:14,color:TEXT}}>家族目標を表示する</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2}}>ランキング画面と毎日タブに進捗を表示</div>
                  </div>
                  <button onClick={()=>setFm({enabled:!fm.enabled})}
                    style={{position:"relative",width:48,height:26,borderRadius:13,background:fm.enabled?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                    <div style={{position:"absolute",top:3,left:fm.enabled?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                  </button>
                </div>
                {fm.enabled&&<>
                  {/* 目標文 */}
                  <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:8}}>目標の文章</div>
                    <input value={fm.label} onChange={e=>setFm({label:e.target.value})}
                      placeholder="例：みんなの活動で 3,000 pt を育てよう"
                      style={{...INP,marginBottom:0}}/>
                  </div>
                  {/* 目標pt */}
                  <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:8}}>目標ポイント</div>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                      {[1000,2000,3000,5000,10000].map(v=>(
                        <button key={v} onClick={()=>setFm({target:v})}
                          style={{padding:"6px 14px",border:`1.5px solid ${fm.target===v?G:BORDER}`,borderRadius:10,background:fm.target===v?`${G}20`:"transparent",color:fm.target===v?G:MUTED,fontWeight:fm.target===v?700:400,fontSize:12,cursor:"pointer",fontFamily:F}}>
                          {v.toLocaleString()}pt
                        </button>
                      ))}
                    </div>
                    <input value={fm.target} onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v)&&v>0)setFm({target:v});}}
                      type="number" placeholder="カスタム値" style={{...INP,marginBottom:0}}/>
                  </div>
                  {/* 達成報酬 */}
                  <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:8}}>達成したらやること</div>
                    <input value={fm.reward} onChange={e=>setFm({reward:e.target.value})}
                      placeholder="例：週末に家族でアイスを選ぶ"
                      style={{...INP,marginBottom:0}}/>
                  </div>
                </>}
              </div>
            );
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
                if(!confirm("この端末からログアウトしますか？\nコードを入力すれば再びアクセスできます。"))return;
                try{localStorage.removeItem(FAMILY_CODE_KEY);}catch(e){}
                _familyCode=null;window.location.reload();
              }} style={{width:"100%",padding:"11px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:12,color:R,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F,marginTop:14}}>
                🚪 この端末からログアウト
              </button>
            </div>);
          })()}
        </div>
      </div>
    </div>
  );
}


// 履歴の1行。取り消しは誤タップ防止のため2タップ確認制(ポイントの増減操作なので慎重に)
function LogRow({ l, emoji, canDelete, child, update, showFlash }){
  const [confirm,setConfirm]=useState(false);
  const deleteLog=()=>{
    const rev={id:uid(),cid:child.id,type:"grant",label:`🗑 取り消し: ${l.label}`,pts:-l.pts,date:new Date().toISOString()};
    addLogToFirestore(rev);
    update(d=>({...d,logs:[rev,...d.logs]}));
    showFlash(-l.pts,"🗑");
    setConfirm(false);
  };
  return(
    <div style={{background:CARD,border:`1.5px solid ${confirm?R:BORDER}`,borderRadius:14,padding:"11px 13px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
      <span style={{fontSize:20}}>{emoji}</span>
      <div style={{flex:1,minWidth:0}}><div style={{fontWeight:700,fontSize:13}}>{l.label}</div><div style={{color:MUTED,fontSize:11}}>{fmtDate(l.date)}</div></div>
      <Pt v={l.pts}/>
      {canDelete&&(confirm
        ? <div style={{display:"flex",gap:5,flexShrink:0}}>
            <button onClick={deleteLog} style={{background:R,border:"none",borderRadius:9,minWidth:60,height:38,color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>取り消す</button>
            <button onClick={()=>setConfirm(false)} style={{background:CARDS,border:`1px solid ${BORDER}`,borderRadius:9,minWidth:44,height:38,color:TEXTS,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>やめる</button>
          </div>
        : <button onClick={()=>setConfirm(true)} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:MUTED,width:44,height:44,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} title="取り消し">🗑</button>)}
    </div>
  );
}

function ChildScreen({ child, data, update, onBack, onFamily }) {
  const [tab, setTab]   = useState("daily");
  // 背景テーマ解決（累計タスクで解放。未解放/autoならデフォルト時間帯背景）
  const _cTotalDone = (data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")).length;
  const totalDoneMon = _cTotalDone;   // もっとタブ(背景/隠しモンスター)の解放判定で使用
  const _bgTid      = (data.bgTheme||{})[child.id] || "auto";   // 背景きせかえの選択中判定で使用
  const _cBgTheme   = BG_THEMES.find(t=>t.id===_bgTid) || BG_THEMES[0];
  const _cBgUnlock  = (_cBgTheme.need||0) <= _cTotalDone;
  const heroGrad    = (_cBgUnlock && _cBgTheme.grad) ? _cBgTheme.grad : null;
  const heroImg     = (_cBgUnlock && _cBgTheme.img) ? _cBgTheme.img : null;
  const heroStars   = _cBgUnlock && _cBgTheme.stars;
  const [flash, setFlash] = useState(null);
  const [pressed, setPressed] = useState({});
  const [gachaRes, setGachaRes] = useState(null);
  const gachaBusyRef = useRef(false);   // ガチャ連打ガード(0.1秒更新中の二重発火/多重回しを防止)
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
  const [showBattle, setShowBattle] = useState(false);
  const [showNews, setShowNews] = useState(false);
  const [nowTs, setNowTs] = useState(Date.now());
  const [showExped, setShowExped] = useState(false);
  useEffect(()=>{const id=setInterval(()=>setNowTs(Date.now()),20000);return()=>clearInterval(id);},[]);
  const [newsSeen, setNewsSeen] = useState(()=>{try{return localStorage.getItem("tane_news_seen")||"";}catch(e){return "";}});
  const hasNews = NEWS.length>0 && newsSeen!==NEWS[0].id;
  const openNews = ()=>{ setShowNews(true); try{localStorage.setItem("tane_news_seen",NEWS[0].id);}catch(e){} setNewsSeen(NEWS[0].id); };

  const ageMode  = child.ageMode || "middle";
  const young    = ageMode === "young";
  const isJunior = child.displayMode === "junior"; // Junior/Teenモード分岐
  // 保護者のゲーム強度設定(familySettings.gameMode): full=全部 / light=ガチャ育成はOKだがバトル・旅オフ / money=お小遣い帳中心(ゲーム要素オフ)
  const gameMode    = (data.familySettings?.gameMode) || "full";
  const showGacha   = gameMode !== "money";   // デイリーガチャ
  const showBattleF = gameMode === "full";    // モンスターバトル・ボス
  const showExpedF  = gameMode === "full";    // とっくんの旅
  const showMissions= gameMode !== "money";   // きょうのミッション
  const thisMonth = new Date().toISOString().slice(0,7);
  const monthDelta = (data.logs||[]).filter(l=>l.cid===child.id&&(l.date||"").startsWith(thisMonth)).reduce((s,l)=>s+l.pts,0);
  const myBal    = bal(data.logs, child.id);
  const myLogs   = (data.logs||[]).filter(l=>l.cid===child.id);
  // ── レベルアップ検知→演出＆報酬(回復カプセル。ptは配らない) ──
  const _mLv = monLevel((data.monsterExp||{})[child.id]||0).lv;
  const [lvPop,setLvPop]=useState(null);
  useEffect(()=>{
    const seen = data.monsterLevelSeen?.[child.id];
    if(seen===undefined){ update(d=> (d.monsterLevelSeen?.[child.id]!==undefined ? d : {...d, monsterLevelSeen:{...(d.monsterLevelSeen||{}),[child.id]:_mLv}}) ); return; }
    if(_mLv>seen){
      let gainedHs=0, gainedHm=0;
      update(d=>{
        const cur=(d.monsterLevelSeen||{})[child.id]; if(cur!==undefined && cur>=_mLv) return d;
        const from=(cur??seen); const cc={...(d.healCaps?.[child.id]||{})};
        for(let L=from+1; L<=_mLv; L++){ if((cc.hs||0)<HEAL_MAX){cc.hs=(cc.hs||0)+1; gainedHs++;} if(L%5===0 && (cc.hm||0)<HEAL_MAX){ cc.hm=(cc.hm||0)+1; gainedHm++; } }
        return {...d, monsterLevelSeen:{...(d.monsterLevelSeen||{}),[child.id]:_mLv}, healCaps:{...(d.healCaps||{}),[child.id]:cc}};
      });
      setLvPop({to:_mLv, hs:gainedHs||(_mLv-seen), hm:gainedHm});
      setTimeout(()=>setLvPop(null),3600);
    }
  // eslint-disable-next-line
  },[_mLv]);
  const todayDone= data.gachaDate?.[child.id] === todayKey();
  const gachaTest = Date.now() < GACHA_TEST_UNTIL; // テスト中フラグ
  const curStreak= data.streak?.[child.id]?.cur || 0;
  const doneTodayIds = new Set(myLogs.filter(l=>l.rid&&(l.date||"").startsWith(todayISO())).map(l=>l.rid));
  const todayTaskDone = myLogs.some(l=>l.type==="good"&&(l.date||"").startsWith(todayISO()));

  // Apply interest on open
  useEffect(()=>{ applyInterest(data,update,child.id); applyHoldingBonus(data,update,child.id); fetchRealStockPrices(data,update); },[]);

  const showFlash = (pts, emoji) => {
    setFlash({pts,emoji}); setTimeout(()=>setFlash(null),1200);
  };

  const addLog = (entry) => {
    update(d => ({ ...d, logs: [{ id:uid(), date:new Date().toISOString(), ...entry }, ...d.logs] }));
  };

  const doTask = task => {
    if(pressed[task.id]) return;   // 連打ガード(二重記録＆巨大state連続再描画でのフリーズ防止)
    const basePts = taskPts(task, child.id);
    // 転生ボーナス適用
    const reincBonus = data.reincarnationBonus?.[child.id];
    const reincActive = reincBonus && new Date().toISOString() < reincBonus.until;
    const pts = (reincActive && basePts > 0) ? Math.round(basePts * (1 + reincBonus.rate)) : basePts;
    const fs = data.familySettings || INIT.familySettings;
    const needApproval = fs.requireApproval && pts > 0;
    const alreadyPending = (data.pendingApprovals||[]).some(p=>p.cid===child.id&&p.taskId===task.id);
    if(alreadyPending) return;
    setPressed(p=>({...p,[task.id]:true}));
    setTimeout(()=>setPressed(p=>{const n={...p};delete n[task.id];return n;}),500);
    if(needApproval) {
      setFlash({pts:0,emoji:"⏳",pending:true});
      setTimeout(()=>setFlash(null),1400);
      const entry={id:uid(),cid:child.id,taskId:task.id,taskLabel:task.label,taskEmoji:task.emoji,pts,date:new Date().toISOString()};
      update(d=>({...d,pendingApprovals:[...(d.pendingApprovals||[]),entry]}));
      if(fs.approvalNotification && "Notification" in window && Notification.permission==="granted"){
        try{new Notification("承認リクエスト 📬",{body:`${child.name}が「${task.label}」を完了しました（+${pts}pt）`,icon:"/assets/tab_daily.png"});}catch(e){}
      }
    } else {
      showFlash(pts, task.emoji);
      // ログ追加＋お手伝いEXP(初回pt×1.5・連打逓減・日次上限)を1回のupdateに統合(再描画を半減)
      update(d=>{
        const e={ id:uid(), date:new Date().toISOString(), cid:child.id, type: pts>=0?"good":"bad", label:task.label, pts, rid:task.id };
        const withLog={...d, logs:[e, ...d.logs]};
        if(pts>0){ const doneToday=(d.logs||[]).filter(l=>l.rid===task.id&&(l.date||"").startsWith(todayISO())).length; const factor=doneToday===0?1.5:doneToday===1?0.6:0.2; return careCap(withLog,child.id,0.25,Math.max(1,pts*factor)); }
        return withLog;
      });
    }
  };

  const doRedeem = r => {
    if(!txGuard("redeem_"+child.id+"_"+r.id)) return;   // 連打ガード(二重交換/二重消費防止)
    setRewardPop(null);
    const _rfs = data.familySettings || INIT.familySettings;
    if(_rfs.rewardApproval) {
      const entry={id:uid(),cid:child.id,rewardId:r.id,rewardEmoji:r.emoji,rewardLabel:r.label,rewardUnit:r.unit,cost:r.cost,date:new Date().toISOString()};
      update(d=>({...d,pendingRedemptions:[...(d.pendingRedemptions||[]),entry]}));
      setFlash({pts:0,emoji:"⏳",pending:true});
      setTimeout(()=>setFlash(null),1400);
    } else {
      showFlash(-r.cost, r.emoji);
      addLog({ cid:child.id, type:"reward", label:`${r.label}（${r.unit}）`, pts:-r.cost, rid:r.id });
    }
  };

  const hasTicket = (data.battleTickets?.[child.id]||0) > 0;
  const doGacha = () => {
    if (gachaBusyRef.current) return;   // 連打ガード: 結果表示を閉じるまで二重に回せない
    const useTicket = todayDone && !gachaTest && hasTicket;
    if (todayDone && !gachaTest && !hasTicket) return;
    gachaBusyRef.current = true;
    let res = rollGacha(data.gacha);
    // 連続日数で「がんばりが報われる」確定演出（7日でSR以上・30日で激レア確定）
    const _gf = (id)=> (data.gacha||[]).find(g=>g.id===id);
    if(curStreak>0){
      if(curStreak%30===0 && res.rate>3){ const g=_gf("gc4"); if(g) res={...g, pts:Math.floor(Math.random()*(g.max-g.min+1))+g.min}; }
      else if(curStreak%7===0 && res.rate>12){ const g=_gf("gc3"); if(g) res={...g, pts:Math.floor(Math.random()*(g.max-g.min+1))+g.min}; }
    }
    const theme = getMonthTheme();
    const bonusPts = 0;   // ストリークボーナスは廃止
    const basePts = res.id==="gc1" ? Math.max(res.pts,5) : res.pts; // ノーマルの最低保証(毎日「来てよかった」)
    const todayTasks = myLogs.filter(l=>(l.type==="good"||l.type==="daily")&&(l.date||"").startsWith(todayISO())).length;
    const tierItems = GACHA_ITEMS.filter(i=>i.tierId===res.id);
    const collItem = tierItems.length>0 ? tierItems[Math.floor(Math.random()*tierItems.length)] : null;
    const isNewItem = collItem ? !(data.gachaCollection?.[child.id]?.[collItem.id]) : false;
    const finalRes = {...res, pts:basePts+bonusPts, bonusPts, theme, collItem, isNewItem, todayTasks, simpleAnim:!!(data.familySettings?.gachaSimple)};
    setGachaRes(finalRes);
    if (gachaTest) return; // テスト中は演出だけ。ポイント/ログ/1日制限を保存しない
    const today = todayKey();
    const prev  = data.streak?.[child.id] || { cur:0, max:0, last:"" };
    const yesterday = (()=>{ const d=new Date(); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; })();
    const newCur = prev.last===yesterday ? prev.cur+1 : 1;
    update(d => ({
      ...d,
      logs: (()=>{ const _e={ id:uid(), cid:child.id, type:"gacha", label:`🎰 ガチャ（${res.label}）`, pts:finalRes.pts, date:new Date().toISOString(), rare:res.rate<=3, tierId:res.id, collItemId:collItem?.id }; addLogToFirestore(_e); return[_e,...d.logs]; })(),
      // チケット使用時は当日記録(gachaDate/streak)を変えず、チケットを1枚消費
      ...(useTicket
        ? { battleTickets: {...(d.battleTickets||{}), [child.id]: Math.max(0,(d.battleTickets?.[child.id]||0)-1)} }
        : { gachaDate: {...(d.gachaDate||{}), [child.id]: today},
            streak: {...(d.streak||{}), [child.id]: { cur:newCur, max:Math.max(prev.max||0,newCur), last:today }} }),
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
  const filtGood = hasFilter?(data.goodTasks||[]).filter(t=>myIds.includes(t.id)):(data.goodTasks||[]);
  const filtBad  = hasFilter?(data.badTasks||[]).filter(t=>myIds.includes(t.id)):(data.badTasks||[]);
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
        const bgAuto=h>=7&&h<11
          ?"linear-gradient(180deg,#1a0a00 0%,#7c2d00 25%,#c2612a 50%,#e8a06a 70%,#2d6a3a 100%)"
          :h>=11&&h<17
          ?"linear-gradient(180deg,#0a2a4a 0%,#1a5c8a 30%,#2a8a5a 65%,#1f7038 100%)"
          :h>=17&&h<20
          ?"linear-gradient(180deg,#1a0a20 0%,#6b2d00 20%,#c25a1a 45%,#7b3a8a 65%,#1a4a28 100%)"
          :h>=20&&h<22
          ?"linear-gradient(180deg,#050d1a 0%,#0a1a30 35%,#0d2a1a 65%,#164a28 100%)"
          :"linear-gradient(180deg,#020508 0%,#050d10 40%,#0a1a10 70%,#0f3020 100%)";
        const bg = heroImg ? `linear-gradient(180deg,rgba(6,10,18,.5) 0%,rgba(6,10,18,.12) 38%,rgba(6,10,18,.42) 100%), url(${heroImg}) center top/cover no-repeat` : (heroGrad || bgAuto);
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
            {((data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length)>0&&(<div style={{position:"absolute",top:-5,right:-5,minWidth:17,height:17,borderRadius:999,background:R,color:"#fff",fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px",lineHeight:1}}>{(data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length}</div>)}
          </button>
        </div>
        <div style={{textAlign:"center",position:"relative",zIndex:2,padding:"16px 0 4px"}}>
          <SeedMonster child={child} data={data} size={130} update={update}/>
        </div>
        {(()=>{
          const m=getMonState(data, child);
          if(m.isFinal) return null;          // 最終形はヒント非表示
          const ready=m.canEvolve;
          const eggS = m.curId==="egg" || /_egg$/.test(String(m.curId));  // 卵は「うまれる」
          const label = ready ? (eggS?"🐣 いまなら うまれるよ！":"🌟 いまならしんかできるよ！")
            : !m.growthOk ? `${eggS?"🐣":"🌟"} あと${m.growthRemain}で${eggS?"うまれる":"しんか"}よ！`
            : `⏳ ${fmtTimeRemain(m.timeRemainMs)}で${eggS?"うまれる":"しんか"}`;
          return(
            <div style={{margin:"0 20px 6px",position:"relative",zIndex:2}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:"#fde68a",fontWeight:700}}>{label}</span>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.45)"}}>{m.growthOk?100:m.growthPct}%</span>
              </div>
              <div style={{height:6,background:"rgba(255,255,255,0.15)",borderRadius:999,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${m.growthOk?100:m.growthPct}%`,background:"linear-gradient(90deg,#fde68a,#f59e0b)",borderRadius:999,transition:"width .6s ease",boxShadow:"0 0 8px rgba(251,191,36,0.6)"}}/>
              </div>
            </div>
          );
        })()}
        <div style={{position:"relative",zIndex:2,margin:"0 16px",background:"rgba(255,255,255,0.12)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderRadius:"18px 18px 0 0",border:"1px solid rgba(255,255,255,0.18)",borderBottom:"none",padding:"14px 18px 16px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{color:"rgba(255,255,255,0.65)",fontSize:11,fontWeight:600,marginBottom:2}}><Emo e={child.emoji} size={12} style={{marginRight:3}}/>{child.name}</div>
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
            <button onClick={()=>setShowTransfer(true)} style={{background:"rgba(255,255,255,0.18)",border:"1.5px solid rgba(255,255,255,0.3)",borderRadius:12,padding:"8px 14px",color:"#fff",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:F}}><Ico name="billfly" fb="💸" size={14} style={{marginRight:3}}/>おくる</button>
          </div>
          {(()=>{const ag=myGoals.find(g=>!g.done&&g.target>0);if(!ag)return null;const pct=Math.min(100,Math.round(myBal/ag.target*100));const rem=Math.max(0,ag.target-myBal);return(
            <div style={{marginTop:10}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"rgba(255,255,255,0.6)",marginBottom:5,fontWeight:700}}>
                <span><Ico name="target" fb="🎯" size={13} style={{marginRight:3}}/>{ag.label}</span><span>{rem>0?`あと ${rem.toLocaleString()}pt`:"たっせい！🎉"}</span>
              </div>
              <div style={{height:7,borderRadius:999,background:"rgba(255,255,255,0.16)",overflow:"hidden"}}>
                <div style={{height:"100%",width:`${pct}%`,borderRadius:999,background:`linear-gradient(90deg,${G},#4ade80)`,transition:"width .4s"}}/>
              </div>
            </div>
          );})()}
          {(()=>{
            const rankable=[...data.children,...(data.parents||[])].filter(m=>m.visibility?.rankingParticipation!==false);
            if(rankable.length<2) return null;
            const sorted=[...rankable].sort((a,b)=>calcMonthlyActivity(b.id,data.logs)-calcMonthlyActivity(a.id,data.logs));
            const rIdx=sorted.findIndex(m=>m.id===child.id);
            if(rIdx<0) return null;
            const medals=["🥇","🥈","🥉"];
            return(
              <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid rgba(255,255,255,0.15)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.45)"}}>今月ランキング</span>
                <button onClick={()=>{setTab("more");setMoreOpen("ranking");}} style={{background:"none",border:"none",cursor:"pointer",fontFamily:F,display:"flex",alignItems:"center",gap:5,padding:0}}>
                  <span style={{fontSize:16}}>{medals[rIdx]||"🏅"}</span>
                  <span style={{fontSize:14,fontWeight:900,color:rIdx===0?"#fde68a":rIdx===1?"#e2e8f0":rIdx===2?"#fed7aa":"rgba(255,255,255,0.8)"}}>{rIdx+1}位</span>
                  <span style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>›</span>
                </button>
              </div>
            );
          })()}
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
      <div style={{background:heroImg?`linear-gradient(180deg,rgba(6,10,18,.55) 0%,rgba(6,10,18,.12) 38%,rgba(6,10,18,.45) 100%), url(${heroImg}) center top/cover no-repeat`:(heroGrad||"linear-gradient(160deg,#060d1a 0%,#0f1a2e 50%,#091220 100%)"),position:"relative",overflow:"hidden"}}>
        {/* 背景グリッド */}
        <div style={{position:"absolute",inset:0,backgroundImage:"linear-gradient(rgba(74,158,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(74,158,255,0.04) 1px,transparent 1px)",backgroundSize:"32px 32px",pointerEvents:"none"}}/>
        {/* 背景テーマの星(うちゅう/よぞら等) */}
        {heroStars && [[10,12],[24,7],[68,10],[84,16],[46,20],[33,5],[58,24],[16,28],[78,30],[90,9],[40,33],[63,38]].map(([l,t],i)=>(
          <div key={"st"+i} style={{position:"absolute",top:`${t}%`,left:`${l}%`,width:i%3===0?3:2,height:i%3===0?3:2,borderRadius:"50%",background:"#fff",opacity:0.45+(i%5)*0.08,pointerEvents:"none"}}/>
        ))}
        {/* アクセントライン */}
        <div style={{position:"absolute",top:0,left:"10%",right:"10%",height:1,background:"linear-gradient(90deg,transparent,rgba(74,158,255,0.4),transparent)",pointerEvents:"none"}}/>
        {/* トップバー */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 20px 0",position:"relative",zIndex:2}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,color:"#e2e8f0"}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:12,color:"rgba(74,158,255,0.7)",letterSpacing:2,textTransform:"uppercase"}}>Tane Money</div>
          <button onClick={()=>setShowSettings(true)} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:"#e2e8f0",position:"relative"}}>
            ⚙
            {((data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length)>0&&(<div style={{position:"absolute",top:-5,right:-5,minWidth:17,height:17,borderRadius:999,background:"#ef4444",color:"#fff",fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px",lineHeight:1}}>{(data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length}</div>)}
          </button>
        </div>
        {/* 残高表示 */}
        <div style={{padding:"20px 20px 18px",position:"relative",zIndex:2,display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1}}>
            <div style={{color:"rgba(255,255,255,0.62)",fontSize:11,fontWeight:700,marginBottom:4,letterSpacing:0.5}}><Emo e={child.emoji} size={12} style={{marginRight:3}}/>{child.name}</div>
            <div style={{display:"flex",alignItems:"flex-end",gap:8,marginBottom:2}}>
              <span style={{color:"#fff",fontSize:38,fontWeight:900,lineHeight:1,letterSpacing:-2}}>{myBal.toLocaleString()}</span>
              <span style={{color:"#4a9eff",fontSize:15,fontWeight:700,marginBottom:5}}>pt</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{color:"rgba(255,255,255,0.58)",fontSize:11}}>今月</span>
              <span style={{fontWeight:700,fontSize:12,color:monthDelta>=0?"#4ade80":"#f87171"}}>{monthDelta>=0?"+":""}{monthDelta.toLocaleString()}pt</span>
              <button onClick={()=>setShowTransfer(true)} style={{marginLeft:"auto",background:"rgba(74,158,255,0.12)",border:"1px solid rgba(74,158,255,0.25)",borderRadius:10,padding:"5px 13px",color:"#4a9eff",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F}}><Ico name="billfly" fb="💸" size={14} style={{marginRight:3}}/>おくる</button>
            </div>
          </div>
          <SeedMonster child={child} data={data} size={100} update={update}/>
        </div>
        {/* 目標までの進捗バー(参考ゲームの進行感を健全に: 直近の未達成目標を1本だけ) */}
        {(()=>{const ag=myGoals.find(g=>!g.done&&g.target>0);if(!ag)return null;const pct=Math.min(100,Math.round(myBal/ag.target*100));const rem=Math.max(0,ag.target-myBal);return(
          <div style={{padding:"0 20px 16px",position:"relative",zIndex:2}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"rgba(255,255,255,0.55)",marginBottom:5,fontWeight:700}}>
              <span><Ico name="target" fb="🎯" size={13} style={{marginRight:3}}/>{ag.label}</span><span>{rem>0?`あと ${rem.toLocaleString()}pt`:"たっせい！🎉"}</span>
            </div>
            <div style={{height:7,borderRadius:999,background:"rgba(255,255,255,0.13)",overflow:"hidden"}}>
              <div style={{height:"100%",width:`${pct}%`,borderRadius:999,background:`linear-gradient(90deg,${G},#4ade80)`,transition:"width .4s"}}/>
            </div>
          </div>
        );})()}
        {/* 4ステータスグリッド */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,padding:"0 20px 24px",position:"relative",zIndex:2}}>
          {[
            ["🔥","連続",curStreak>0?`${curStreak}日`:null,"#fde68a","daily","毎日開こう","flame"],
            ["⚡","タスク",ttd>0?`${ttd}回`:null,"#a78bfa","activity","タスクをやろう","clipboard"],
            ["📊","ポートフォリオ",portV2>0?`${portV2.toLocaleString()}pt`:null,"#4ade80","activity","株を買おう","chartup"],
            ["🏅","バッジ",myBadges>0?`${myBadges}個`:null,"#fbbf24","more","実績を稼ごう","medal"],
          ].map(([e,l,v,c,tabTarget,hint,ic])=>(
            <div key={l} onClick={()=>{if(!v)setTab(tabTarget);}}
              style={{background:"rgba(255,255,255,0.04)",border:`1px solid ${!v?"rgba(74,158,255,0.15)":"rgba(255,255,255,0.07)"}`,borderRadius:14,padding:"12px 14px",cursor:!v?"pointer":"default",transition:"background .15s"}}>
              <div style={{marginBottom:3}}><Ico name={ic} fb={e} size={24}/></div>
              <div style={{color:"rgba(255,255,255,0.58)",fontSize:11,fontWeight:700,letterSpacing:0.5,marginBottom:3}}>{l}</div>
              {v ? (
                <div style={{color:c,fontSize:17,fontWeight:900}}>{v}</div>
              ) : (
                <div style={{color:"rgba(74,158,255,0.6)",fontSize:11,lineHeight:1.4}}>{hint} →</div>
              )}
            </div>
          ))}
        </div>
      </div>
        );
      })()}
      {/* タブナビゲーション */}
      <div style={{display:"flex",background:isJunior?CARD:"#0f1a2e",borderBottom:isJunior?`1px solid ${BORDER}`:"1px solid rgba(74,158,255,0.12)",overflowX:"auto",scrollbarWidth:"none",position:"sticky",top:0,zIndex:100,boxShadow:isJunior?"0 2px 8px rgba(24,35,29,0.04)":"0 2px 12px rgba(0,0,0,0.4)"}}>
        {MAIN_TABS.map(([v,l])=>{
          // 控えめな金色ドット: 「今日まだのおてつだい」と「今日まだのガチャ」だけ(最大2個)。やり終えたら消える。
          const tabDot = ((v==="activity"||v==="tasks") && !todayTaskDone) || (v==="daily" && showGacha && !todayDone && !gachaTest);
          return (
          <button key={v} onClick={()=>setTab(v)}
            style={{position:"relative",flex:1,padding:"7px 4px 7px",border:"none",borderBottom:effectiveTab===v?`2.5px solid ${isJunior?GP:"#4a9eff"}`:"2.5px solid transparent",background:"none",color:effectiveTab===v?(isJunior?GP:"#4a9eff"):(isJunior?MUTED:"rgba(255,255,255,0.35)"),fontWeight:effectiveTab===v?700:500,fontSize:12,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap",minWidth:56,transition:"all .15s",display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
            <span style={{position:"relative",display:"inline-flex"}}>
              <img src={`/assets/tab_${v}.png`} alt="" style={{width:22,height:22,objectFit:"contain",opacity:effectiveTab===v?1:0.4,filter:(!isJunior&&effectiveTab!==v)?"brightness(0.6)":"none",transition:"opacity .15s"}} onError={e=>{const s=document.createElement("span");s.textContent="🐣";s.style.fontSize="20px";s.style.opacity=effectiveTab===v?"1":"0.5";e.target.replaceWith(s);}}/>
              {tabDot && <span style={{position:"absolute",top:-3,right:-6,width:9,height:9,borderRadius:"50%",background:GOLD,border:`1.5px solid ${isJunior?CARD:"#0f1a2e"}`}}/>}
            </span>
            {l.replace(/^\S+\s+/,"")}
          </button>
          );
        })}
      </div>

      {/* 🐣 そだてる フローティングボタン(ガチャと同様・rpg以外の画面で左下に常駐) */}
      {effectiveTab!=="rpg" && (
        <button onClick={()=>setTab("rpg")} aria-label="そだてる"
          style={{position:"fixed",left:16,bottom:24,zIndex:120,width:66,height:66,borderRadius:"50%",border:"3px solid #fff",
            background:"radial-gradient(circle at 35% 35%,#b07bff,#7b61c9)",boxShadow:"0 6px 22px rgba(123,97,201,.6)",
            cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:0,fontFamily:F,
            animation:"sodateFab 1.8s ease-in-out infinite"}}>
          <span style={{fontSize:26,lineHeight:1}}>🐣</span>
          <span style={{fontSize:9,fontWeight:900,color:"#fff",lineHeight:1,marginTop:1}}>そだてる</span>
          <style>{`@keyframes sodateFab{0%,100%{transform:scale(1) translateY(0)}50%{transform:scale(1.09) translateY(-3px)}}`}</style>
        </button>
      )}

      {/* 🌱 はたけ フローティングボタン(そだてるボタンの上に重ねて常駐・株/畑ワールドへ) */}
      {effectiveTab!=="rpg" && !data.familySettings?.investOff && (isJunior||!young)
        && !(isJunior?(effectiveTab==="money"&&monTab==="hatake"):(effectiveTab==="activity"&&actTab==="invest")) && (
        <button onClick={()=>{ if(isJunior){setTab("goals");setMonTab("hatake");} else {setTab("activity");setActTab("invest");} }} aria-label="はたけ"
          style={{position:"fixed",left:16,bottom:98,zIndex:120,width:66,height:66,borderRadius:"50%",border:"3px solid #fff",
            background:"radial-gradient(circle at 35% 35%,#5fd699,#2e9e6a)",boxShadow:"0 6px 22px rgba(46,158,106,.55)",
            cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:0,fontFamily:F,
            animation:"hatakeFab 2.1s ease-in-out infinite"}}>
          <span style={{fontSize:26,lineHeight:1}}>🌱</span>
          <span style={{fontSize:9,fontWeight:900,color:"#fff",lineHeight:1,marginTop:1}}>はたけ</span>
          <style>{`@keyframes hatakeFab{0%,100%{transform:scale(1) translateY(0)}50%{transform:scale(1.07) translateY(-3px)}}`}</style>
        </button>
      )}

      {/* 📢 おしらせ(新機能の告知) */}
      {effectiveTab==="daily" && (
        <div style={{padding:"10px 16px 0"}}>
          <button onClick={openNews} style={{width:"100%",display:"flex",alignItems:"center",gap:8,background:darkBG?"rgba(255,255,255,0.05)":CARD,border:`1.5px solid ${hasNews?GOLD:(darkBG?"rgba(255,255,255,0.1)":BORDER)}`,borderRadius:14,padding:"9px 14px",cursor:"pointer",fontFamily:F}}>
            <span style={{fontSize:16}}>📢</span>
            <span style={{flex:1,textAlign:"left",fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.85)":TEXT}}>おしらせ{hasNews?"・新機能があるよ！":""}</span>
            {hasNews && <span style={{fontSize:10,fontWeight:900,color:"#fff",background:R,borderRadius:999,padding:"2px 8px"}}>NEW</span>}
            <span style={{fontSize:13,color:MUTED}}>›</span>
          </button>
        </div>
      )}

      {/* 🎯 きょうのミッション(毎日リセット) ※ユーザー要望で非表示(falseで無効化・復活可) */}
      {false && effectiveTab==="daily" && showMissions && (()=>{
        const tISO=todayISO(), tk=todayKey();
        const metrics={
          tasks: myLogs.filter(l=>(l.type==="good"||l.type==="daily")&&(l.date||"").startsWith(tISO)).length,
          care: (data.monsterCare?.[child.id]?.last===tk)?1:0,
          learn: myLogs.filter(l=>l.type==="tips"&&(l.date||"").startsWith(tISO)).length,
          battle: (data.battleWinDate?.[child.id]===tk)?1:0,
        };
        // まめちしきはJuniorに無い画面なので除外。バトルオフ(light/money)ではバトルミッションも除外
        const dailyMissions=MISSIONS.filter(m=>(isJunior?m.metric!=="learn":true) && (showBattleF?true:m.metric!=="battle"));
        const mcRaw=data.missionClaimed?.[child.id];
        const claimed=(mcRaw&&mcRaw.date===tk)?(mcRaw.ids||[]):[];
        const allClaimed=claimed.length>=dailyMissions.length;
        const doneCount=dailyMissions.filter(m=>metrics[m.metric]>=m.goal).length;
        const claim=(id,exp)=>update(d=>{
          const mc=d.missionClaimed?.[child.id]; const ids=(mc&&mc.date===tk)?(mc.ids||[]):[];
          if(ids.includes(id))return d; const nids=[...ids,id];
          let nd={...d, missionClaimed:{...(d.missionClaimed||{}),[child.id]:{date:tk,ids:nids}}, monsterExp:{...(d.monsterExp||{}),[child.id]:((d.monsterExp?.[child.id])||0)+exp}};
          if(nids.length>=dailyMissions.length){ let frag=((d.battleFragments?.[child.id])||0)+1; let tic=(d.battleTickets?.[child.id])||0; if(frag>=5){frag-=5;tic+=1;} nd.battleFragments={...(d.battleFragments||{}),[child.id]:frag}; nd.battleTickets={...(d.battleTickets||{}),[child.id]:tic}; }
          return nd;
        });
        return (
          <div style={{padding:"10px 16px 0"}}>
            <div style={{background:darkBG?"rgba(255,255,255,0.05)":CARD,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderRadius:16,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.85)":TEXT}}>🎯 きょうのミッション</span>
                <span style={{fontSize:11,color:MUTED,fontWeight:700}}>{doneCount}/{dailyMissions.length}{allClaimed?" ✓":""}</span>
              </div>
              {dailyMissions.map(m=>{
                const prog=Math.min(metrics[m.metric],m.goal); const done=prog>=m.goal; const isClaimed=claimed.includes(m.id);
                return <div key={m.id} style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0"}}>
                  <span style={{fontSize:17,width:22,textAlign:"center"}}>{m.e}</span>
                  <div style={{flex:1,minWidth:0,fontSize:12.5,fontWeight:700,color:done?(darkBG?"#bff0c8":G):(darkBG?"rgba(255,255,255,0.75)":TEXT)}}>{m.label} <span style={{color:MUTED,fontWeight:600}}>{prog}/{m.goal}</span></div>
                  {isClaimed
                    ? <span style={{fontSize:11,fontWeight:800,color:MUTED,flexShrink:0}}>✓ もらった</span>
                    : done
                    ? <button onClick={()=>claim(m.id,m.exp)} style={{background:GP,border:"none",borderRadius:999,padding:"5px 12px",color:"#fff",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,flexShrink:0}}>+{m.exp}EXP</button>
                    : <span style={{fontSize:11,color:MUTED,flexShrink:0}}>あと{m.goal-prog}</span>}
                </div>;
              })}
              {allClaimed && <div style={{marginTop:6,fontSize:11,color:darkBG?"#bff0c8":G,fontWeight:700,textAlign:"center"}}>🎉 ぜんぶ達成！🧩 かけらGET！</div>}
            </div>
          </div>
        );
      })()}

      {/* ── 🐣 そだてる(rpg)タブ: モンスターのハブ ── */}
      {effectiveTab==="rpg" && (
        <div style={{padding:"14px 16px 4px"}}>
          <button onClick={()=>setTab("daily")} style={{display:"flex",alignItems:"center",gap:6,background:darkBG?"rgba(255,255,255,0.08)":CARD,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.15)":BORDER}`,borderRadius:999,padding:"7px 14px",color:darkBG?"#fff":TEXT,fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F,marginBottom:10}}>← もどる</button>
          <div style={{textAlign:"center",marginBottom:6}}>
            <SeedMonster child={child} data={data} size={120} update={update}/>
          </div>
          {showBattleF && <button onClick={()=>setShowBattle(true)} style={{width:"100%",background:"linear-gradient(135deg,#7b61c9,#5a3fb0)",border:"none",borderRadius:16,padding:"14px",color:"#fff",fontWeight:900,fontSize:16,cursor:"pointer",fontFamily:F,display:"flex",alignItems:"center",justifyContent:"center",gap:8,boxShadow:"0 4px 16px rgba(123,97,201,.4)"}}>⚔ モンスターバトル</button>}
          {!showBattleF && <div style={{textAlign:"center",fontSize:12,color:darkBG?"rgba(255,255,255,0.5)":MUTED,padding:"8px"}}>バトルは保護者設定でオフになっています</div>}
        </div>
      )}

      {/* 🥚 ヤミノオウのタマゴを持っているとき: 育て始める(=今の相棒を卒業して、ヤミノオウを通常タネモンとして育成) */}
      {effectiveTab==="rpg" && data.yamiEgg?.[child.id] && (()=>{
        const startYami=()=>{ if(typeof window!=="undefined" && !window.confirm("ヤミノオウのタマゴを 育てはじめる？\n今の あいぼうは 図鑑(うちのこ)へ 卒業して、ヤミノオウのタマゴが 新しい あいぼうに なるよ。")) return;
          update(d=>{ const curId=(d.monsterEvolved||{})[child.id]; const curDef=curId?MONSTER_TREE[curId]:null;
            const coll=(curId && curDef)?[...((d.collectedMons||{})[child.id]||[]),{species:String(curId).split("_")[0],id:curId,name:curDef.name,rarity:curDef.rarity||1,date:new Date().toISOString()}]:((d.collectedMons||{})[child.id]||[]);
            return {...d, collectedMons:{...(d.collectedMons||{}),[child.id]:coll},
              monsterEvolved:{...(d.monsterEvolved||{}),[child.id]:"yami_egg"},
              monsterEvolvedAt:{...(d.monsterEvolvedAt||{}),[child.id]:null},
              monsterStageAt:{...(d.monsterStageAt||{}),[child.id]:new Date().toISOString()},
              monsterIV:{...(d.monsterIV||{}),[child.id]:{hp:7,atk:7,def:7,spd:7}},
              monsterDiscovered:{...(d.monsterDiscovered||{}),[child.id]:[...new Set([...((d.monsterDiscovered||{})[child.id]||[]),"yami_egg"])]},
              yamiEgg:{...(d.yamiEgg||{}),[child.id]:false} }; });
        };
        return (
          <div style={{padding:"0 16px 8px"}}>
            <div style={{position:"relative",overflow:"hidden",background:"linear-gradient(135deg,#2a1f4a,#3d2b66)",border:"1.5px solid #7b61c9",borderRadius:16,padding:"13px 15px",color:"#fff"}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:34}}>🥚</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:900,fontSize:14}}>👑 ヤミノオウの タマゴ を持っている！</div>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:2,lineHeight:1.5}}>育てはじめると あいぼうに なるよ。ふつうの タネモンと 同じく お手伝い・なでなで・時間で 進化して、究極体 ヤミノオウ を めざそう！</div>
                </div>
              </div>
              <button onClick={startYami} style={{marginTop:10,width:"100%",background:"linear-gradient(135deg,#7b61c9,#b07bff)",border:"none",borderRadius:12,padding:"11px",color:"#fff",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:F}}>🥚 このタマゴを 育てる（今の あいぼうは 卒業）</button>
            </div>
          </div>
        );
      })()}

      {/* 🧭 とっくんの旅(旅先を選択・遠いほどEXP大・放置系) */}
      {effectiveTab==="rpg" && showExpedF && (()=>{
        const exp=data.expedition?.[child.id];
        const started=exp&&exp.start;
        const dest=EXPEDITIONS.find(e=>e.id===exp?.dest)||EXPEDITIONS[0];
        const DUR=dest.mins*60000;
        const remain=started?Math.max(0,DUR-(nowTs-new Date(exp.start).getTime())):0;
        const back=started&&remain<=0;
        const claim=()=>update(d=>{
          const gotFrag=Math.random()<dest.frag;
          let nd={...d, expedition:{...(d.expedition||{}),[child.id]:null}, monsterExp:{...(d.monsterExp||{}),[child.id]:((d.monsterExp?.[child.id])||0)+dest.exp}};
          if(gotFrag){ let frag=((d.battleFragments?.[child.id])||0)+1; let tic=(d.battleTickets?.[child.id])||0; if(frag>=5){frag-=5;tic+=1;} nd.battleFragments={...(d.battleFragments||{}),[child.id]:frag}; nd.battleTickets={...(d.battleTickets||{}),[child.id]:tic}; }
          if(Math.random()<0.15) nd=gainHealItem(nd,child.id,"potion");  // たまに回復アイテム(上限あり)
          return nd;
        });
        const pct=started?Math.min(100,Math.round((1-remain/DUR)*100)):0;
        return (
          <div style={{padding:"10px 16px 0"}}>
            <div style={{background:darkBG?"rgba(123,97,201,0.14)":"#f1ecfb",border:`1.5px solid ${darkBG?"rgba(155,124,255,0.4)":P+"55"}`,borderRadius:16,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:24}}>{started?dest.e:"🧭"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:800,fontSize:13,color:darkBG?"#d9ccff":P}}>とっくんの旅</div>
                  <div style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.55)":TEXTS,marginTop:1}}>
                    {!started?"旅先をえらんで EXPをかせごう！":back?`${dest.name}から かえってきた！`:`${dest.name}へ 旅のとちゅう… のこり ${Math.ceil(remain/60000)}分`}
                  </div>
                </div>
                {!started && <button onClick={()=>setShowExped(true)} style={{background:P,border:"none",borderRadius:999,padding:"8px 14px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F,flexShrink:0}}>旅先をえらぶ</button>}
                {back && <button onClick={claim} style={{background:GP,border:"none",borderRadius:999,padding:"8px 14px",color:"#fff",fontWeight:900,fontSize:12,cursor:"pointer",fontFamily:F,flexShrink:0}}>🎁 EXP+{dest.exp} うけとる</button>}
              </div>
              {started && !back && <div style={{height:7,borderRadius:999,background:darkBG?"rgba(255,255,255,0.12)":"#e3dbf5",overflow:"hidden",marginTop:9}}><div style={{height:"100%",width:`${pct}%`,background:`linear-gradient(90deg,${P},#9b7cff)`,borderRadius:999,transition:"width .5s"}}/></div>}
            </div>
          </div>
        );
      })()}

      {curStreak>=3 && !todayTaskDone && effectiveTab==="daily" && (
        <div style={{margin:"10px 16px 0",background:`linear-gradient(135deg,#fff8e1,#fffde7)`,border:`2px solid ${GOLD}`,borderRadius:14,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:24}}>🔥</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:13,color:"#b45309"}}>連続{curStreak}日！すごいね✨</div>
            <div style={{fontSize:11,color:MUTED,marginTop:1}}>きょうも 1つ やって つづけよう！</div>
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
      {gachaRes && <GachaAnim result={gachaRes} onClose={()=>{setGachaRes(null); gachaBusyRef.current=false;}}/>}
      {/* 🎉 レベルアップ演出(報酬: 回復カプセル) */}
      {lvPop && (
        <div onClick={()=>setLvPop(null)} style={{position:"fixed",inset:0,background:"#0007",zIndex:1200,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F,pointerEvents:"auto"}}>
          <div style={{background:"linear-gradient(135deg,#fff7e0,#ffe9a8)",border:"3px solid #E8B83E",borderRadius:22,padding:"22px 26px",textAlign:"center",boxShadow:"0 0 40px rgba(232,184,62,.8)",animation:"lvPopIn .5s cubic-bezier(.2,1.4,.4,1)"}}>
            <div style={{fontSize:13,fontWeight:900,color:"#9a7000",letterSpacing:2}}>✨ レベルアップ！ ✨</div>
            <div style={{fontWeight:900,fontSize:42,color:"#E8B83E",lineHeight:1.1,margin:"4px 0",textShadow:"0 2px 0 #fff"}}>Lv.{lvPop.to}</div>
            <div style={{fontSize:12,fontWeight:800,color:"#7c5a00"}}>称号：{monRank(lvPop.to)}</div>
            <div style={{marginTop:10,background:"#fff",borderRadius:12,padding:"8px 12px",fontSize:12.5,fontWeight:800,color:TEXT}}>
              🎁 ごほうび：🟢回復カプセル小 ×{lvPop.hs}{lvPop.hm>0?` ・ 🔵中 ×${lvPop.hm}`:""}
            </div>
            <div style={{fontSize:11,color:MUTED,marginTop:8,lineHeight:1.5}}>つみ重ねた努力が 力に！HP・こうげき・素早さ UP</div>
            <button onClick={()=>setLvPop(null)} style={{marginTop:12,background:"#E8B83E",border:"none",borderRadius:12,padding:"9px 22px",color:"#3a2a00",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:F}}>やったー！</button>
          </div>
          <style>{`@keyframes lvPopIn{0%{transform:scale(.3) rotate(-8deg);opacity:0}100%{transform:scale(1) rotate(0);opacity:1}}`}</style>
        </div>
      )}
      {showBattle && <BattleModal child={child} data={data} update={update} onClose={()=>setShowBattle(false)}/>}
      {showNews && <NewsModal onClose={()=>setShowNews(false)}/>}
      {showExped && <ExpeditionModal child={child} data={data} update={update} onClose={()=>setShowExped(false)}/>}

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
      {effectiveTab==="daily" && showGacha && <>
        {/* フローティング・ガチャボタン: タスクが多くても埋もれず常にワンタップで引ける */}
        {(()=>{ const ft=getMonthTheme(); return (
          <button onClick={()=>{ if(!todayDone||gachaTest||hasTicket) doGacha(); }} disabled={todayDone&&!gachaTest&&!hasTicket} aria-label="デイリーガチャ"
            style={{position:"fixed",right:16,bottom:24,zIndex:120,width:66,height:66,borderRadius:"50%",
              border:todayDone?`2px solid ${BORDER}`:"3px solid #fff",
              background:todayDone?"radial-gradient(circle at 35% 35%,#d2d2d2,#a8a8a8)":`radial-gradient(circle at 35% 35%,${ft.bg},${ft.color})`,
              boxShadow:todayDone?"0 4px 12px rgba(0,0,0,0.25)":`0 6px 22px ${ft.color}95`,
              cursor:todayDone?"default":"pointer",fontSize:30,display:"flex",alignItems:"center",justifyContent:"center",
              animation:todayDone?"none":"gachaFab 1.6s ease-in-out infinite",fontFamily:F}}>
            {todayDone?"✓":ft.emoji}
            {!todayDone&&<span style={{position:"absolute",top:-7,right:-8,background:R,color:"#fff",fontSize:11,fontWeight:900,borderRadius:10,padding:"1px 6px",border:"1.5px solid #fff",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}>ひく！</span>}
          </button>
        );})()}
        <style>{`@keyframes gachaFab{0%,100%{transform:scale(1) translateY(0)}50%{transform:scale(1.09) translateY(-3px)}}`}</style>
        {data.firstActionPending&&(data.goodTasks||[]).length>0&&(
          <div style={{background:GS,border:`2px solid ${G}`,borderRadius:16,padding:"14px 16px",marginBottom:16,position:"relative"}}>
            <button onClick={()=>update(d=>({...d,firstActionPending:false}))} style={{position:"absolute",top:8,right:10,background:"none",border:"none",fontSize:16,cursor:"pointer",color:MUTED}}>✕</button>
            <div style={{fontWeight:900,fontSize:14,color:GP,marginBottom:6}}>🌱 さあ、はじめよう！</div>
            <div style={{color:TEXTS,fontSize:13,lineHeight:1.7,marginBottom:10}}>
              「活動」タブを開いて、{(data.goodTasks||[])[0]?.emoji}{(data.goodTasks||[])[0]?.label}をタップしてみよう！
            </div>
            <button onClick={()=>{
              update(d=>({...d,firstActionPending:false}));
              setTab(isJunior?"tasks":"activity");
            }} style={{background:GP,border:"none",borderRadius:10,padding:"8px 18px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>
              活動タブへ →
            </button>
          </div>
        )}
        {/* ── スタートクエスト ── */}
        {!((data.beginnerMissionDone||{})[child.id])&&(()=>{
          const claimed=(data.claimedMissions||{})[child.id]||[];
          const quests=[
            {id:"q1",emoji:"⭐",label:"タスクをやろう",hint:isJunior?"「やること」タブでお手伝いをやってみよう":"「活動」タブでお手伝いをやってみよう",done:myLogs.some(l=>l.type==="good"||l.type==="bad")||(data.pendingApprovals||[]).some(p=>p.cid===child.id),nav:()=>setTab(isJunior?"tasks":"activity")},
            {id:"q2",emoji:"🎰",label:"ガチャを引こう",hint:"今日のガチャを1回引いてみよう",done:myLogs.some(l=>l.type==="gacha"),nav:null},
            {id:"q3",emoji:"🎯",label:"目標を1つ決めよう",hint:"「ためる」タブで貯金の目標を作ってみよう",done:(data.goals||[]).some(g=>g.cid===child.id),nav:()=>{if(isJunior){setTab("goals");}else{setTab("money");setMonTab("goals");}}},
            ...(!isJunior?[{id:"q4",emoji:"🛍",label:"ポイントをつかってみよう",hint:"「ためる」タブのこうかんで使えるよ",done:myLogs.some(l=>l.type==="reward"),nav:()=>{setTab("money");setMonTab("rewards");}}]:[]),
          ];
          const totalQ=quests.length;
          const doneCnt=quests.filter(q=>q.done).length;
          const totalBonus=totalQ===4?300:250;
          const claimQuest=(qId)=>{
            const qLabel=quests.find(q=>q.id===qId)?.label||"";
            const e={id:uid(),cid:child.id,type:"grant",label:`🎉 クエスト完了「${qLabel}」`,pts:50,date:new Date().toISOString()};
            update(d=>{
              const nc=[...(d.claimedMissions?.[child.id]||[]),qId];
              const allQ=quests.every(q=>nc.includes(q.id));
              const alreadyDone=!!(d.beginnerMissionDone?.[child.id]);
              const newLogs=[e,...d.logs];
              if(allQ&&!alreadyDone){
                const e2={id:uid(),cid:child.id,type:"grant",label:"🏆 スタートクエスト全クリア！",pts:100,date:new Date().toISOString()};
                addLogToFirestore(e); addLogToFirestore(e2);
                return{...d,logs:[e2,...newLogs],claimedMissions:{...(d.claimedMissions||{}),[child.id]:nc},beginnerMissionDone:{...(d.beginnerMissionDone||{}),[child.id]:true}};
              }
              addLogToFirestore(e);
              return{...d,logs:newLogs,claimedMissions:{...(d.claimedMissions||{}),[child.id]:nc}};
            });
            showFlash(50,"🎉");
          };
          const unclaimed=quests.filter(q=>!claimed.includes(q.id));
          if(unclaimed.length===0) return null;
          return(
            <div style={{padding:"10px 16px 0"}}>
              <div style={{background:CARD,borderRadius:16,padding:"14px 14px 10px",border:`1.5px solid ${BORDER}`,boxShadow:SHADOW}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <span style={{fontSize:20}}>🌱</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:900,fontSize:13,color:TEXT}}>スタートクエスト</div>
                    <div style={{fontSize:11,color:MUTED}}>全部やると合計+{totalBonus}pt！</div>
                  </div>
                  <div style={{fontSize:11,fontWeight:800,color:doneCnt===totalQ?GP:MUTED}}>{doneCnt}/{totalQ}</div>
                </div>
                <div style={{background:BORDER,borderRadius:999,height:4,marginBottom:10,overflow:"hidden"}}>
                  <div style={{width:`${doneCnt/totalQ*100}%`,height:"100%",background:G,borderRadius:999,transition:"width .4s"}}/>
                </div>
                {unclaimed.map(q=>(
                  <div key={q.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderTop:`1px solid ${BORDER}`}}>
                    <span style={{fontSize:16,flexShrink:0}}>{q.done?"✅":q.emoji}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:12,color:q.done?GP:TEXT}}>{q.label}</div>
                      {!q.done&&<div style={{fontSize:11,color:MUTED,marginTop:1}}>{q.hint}</div>}
                      {q.done&&<div style={{fontSize:11,color:GP,marginTop:1}}>達成！+50pt うけとれるよ</div>}
                    </div>
                    {q.done
                      ?<button onClick={()=>claimQuest(q.id)} style={{background:G,border:"none",borderRadius:10,padding:"5px 12px",color:"#fff",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,flexShrink:0}}>うけとる</button>
                      :<button onClick={()=>q.nav&&q.nav()} disabled={!q.nav} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"5px 12px",color:MUTED,fontWeight:700,fontSize:11,cursor:q.nav?"pointer":"default",fontFamily:F,flexShrink:0}}>やってみる</button>
                    }
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
        {/* タスクを先に表示（ガチャより優先）— Junior/Teen共通 */}
        {!isJunior && <>
          <div style={{color:"rgba(255,255,255,0.6)",fontSize:11,fontWeight:700,letterSpacing:1.5,padding:"14px 16px 0"}}>きょうの やること</div>
          <TabHint id="daily" text="今日のタスクをやってポイントをゲット！連続記録でボーナスも🌟" data={data} update={update} cid={child.id}/>
          <DailyTasks child={child} data={data} update={update}/>
        </>}
        {isJunior && <>
          <TabHint id="daily" text="毎日タスクをチェックしよう！全部クリアするとボーナスポイントがもらえるよ🌟" data={data} update={update} cid={child.id}/>
          <DailyTasks child={child} data={data} update={update}/>
        </>}
        {/* ── デイリーガチャ（タスクの下＝ごほうび。Junior/Teen共通）。money モードでは非表示 ── */}
        {showGacha && <div style={{padding:"12px 16px 4px"}}>
          {!isJunior&&<div style={{color:"rgba(255,255,255,0.58)",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8}}>🎰 きょうの ガチャ</div>}
          {(()=>{
            const mTheme=getMonthTheme();
            const bonusLabel=curStreak>=30?"+50pt":curStreak>=10?"+20pt":curStreak>=5?"+10pt":null;
            const monthGacha=myLogs.filter(l=>l.type==="gacha"&&(l.date||"").startsWith(monthKey()));
            const todayChores=myLogs.filter(l=>(l.type==="good"||l.type==="daily")&&(l.date||"").startsWith(todayISO())).length;
            const tierCounts=(data.gacha||[]).map(tier=>({...tier,count:monthGacha.filter(l=>l.tierId===tier.id||(l.label||"").includes(tier.label)).length}));
            return(<>
              <div style={{background:darkBG?(todayDone?"rgba(255,255,255,0.05)":"rgba(255,255,255,0.07)"):(todayDone?CARD:`linear-gradient(135deg,${mTheme.bg},#fffbe6)`),border:darkBG?`1px solid ${todayDone?"rgba(255,255,255,0.1)":mTheme.color+"50"}`:`2px solid ${todayDone?BORDER:mTheme.color}`,borderRadius:20,padding:"16px 18px",display:"flex",alignItems:"center",gap:14}}>
                <button onClick={doGacha} disabled={todayDone&&!gachaTest&&!hasTicket}
                  style={{width:62,height:62,borderRadius:"50%",border:"none",flexShrink:0,
                    background:todayDone?"radial-gradient(circle at 35% 35%,#ccc,#aaa)":`radial-gradient(circle at 35% 35%,${mTheme.bg},${mTheme.color})`,
                    fontSize:28,cursor:todayDone?"default":"pointer",
                    boxShadow:todayDone?"none":`0 4px 16px ${mTheme.color}60`,
                    animation:todayDone?"none":"glow 2s ease-in-out infinite"}}>
                  {mTheme.emoji}
                </button>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:mTheme.color,fontWeight:700,marginBottom:2}}>{mTheme.emoji} {mTheme.name}ガチャ</div>
                  <div style={{fontWeight:800,fontSize:14,color:darkBG?((todayDone&&!gachaTest)?"rgba(255,255,255,0.35)":"#fff"):((todayDone&&!gachaTest)?MUTED:TEXT)}}>
                    {gachaTest?"🧪 テスト回し放題":(todayDone?(darkBG?"ひいたよ！":"✅ 今日は引き済み！"):"デイリーガチャ")}
                  </div>
                  <div style={{fontSize:12,color:darkBG?"rgba(255,255,255,0.3)":MUTED,marginTop:2}}>
                    {gachaTest?"何回でもOK（記録は残りません・〜01:30）":(todayDone?(darkBG?"また あした":"また明日ね🌙"):`1日1回 · 最大${Math.max(...(data.gacha||[]).map(g=>g.max))}pt`)}
                  </div>
                  {!todayDone&&!gachaTest&&<div style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.42)":MUTED,marginTop:3}}>かくりつ ⚪60 🔵25 🟡12 🔴3 ％</div>}
                  {bonusLabel&&!todayDone&&<div style={{marginTop:4,fontSize:11,color:R,fontWeight:700}}>🔥 {curStreak}連続ボーナス {bonusLabel}！</div>}
                  {!bonusLabel&&curStreak>=3&&!todayDone&&<div style={{marginTop:4,fontSize:11,color:R,fontWeight:700}}>🔥 {curStreak}日連続中！</div>}
                  {todayDone&&darkBG&&(()=>{const coll=data.gachaCollection?.[child.id]||{};const rem=GACHA_ITEMS.length-GACHA_ITEMS.filter(i=>(coll[i.id]||0)>0).length;return rem>0?<div style={{marginTop:5,fontSize:11,color:"rgba(74,158,255,0.55)",fontWeight:700}}>図鑑のこり{rem}体 · ぜんぶ あつめよう</div>:<div style={{marginTop:5,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:11,color:"#fbbf24",fontWeight:700}}>ぜんぶ あつめた ★</span><span onClick={(e)=>{e.stopPropagation();shareCard({emoji:"🏆",title:"ずかん コンプリート！",subtitle:`${GACHA_ITEMS.length}しゅるい ぜんぶ あつめた`,color:"#fbbf24"});}} style={{fontSize:11,color:"#4a9eff",fontWeight:800,cursor:"pointer"}}>シェア 📤</span></div>;})()}
                </div>
                {!todayDone&&<div style={{fontSize:11,background:mTheme.bg,color:mTheme.color,padding:"4px 10px",borderRadius:999,fontWeight:700,flexShrink:0,border:`1px solid ${mTheme.color}40`}}>TAP！</div>}
              </div>
              <div style={{marginTop:6,display:"flex",gap:10,flexWrap:"wrap",fontSize:11,fontWeight:800}}>
                {!todayDone&&(todayChores>0
                  ? <span style={{color:darkBG?"#bff0c8":G}}>🌱 きょうのお手伝い {todayChores}こ・タネが げんき！</span>
                  : <span style={{color:darkBG?"#ffd9a8":"#9a7000"}}>💪 さきに お手伝いすると タネが もっと げんきに！</span>)}
                {hasTicket&&<span style={{color:darkBG?"#bff0c8":G}}>🎟 チケット{data.battleTickets[child.id]}まい・ガチャもう1回！</span>}
                <span style={{color:darkBG?"rgba(255,255,255,0.5)":MUTED}}>🧩 チケットのかけら {(data.battleFragments?.[child.id]||0)}/5</span>
              </div>
              {/* モンスターバトルは「そだてる」タブへ移動 */}
              {monthGacha.length>0&&(
                <div style={{marginTop:8,display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.45)":MUTED,fontWeight:600}}>今月:</span>
                  {tierCounts.filter(t=>t.count>0).map(t=>(
                    <span key={t.id} style={{fontSize:11,background:darkBG?"rgba(255,255,255,0.06)":CARD,border:`1px solid ${t.color}50`,borderRadius:999,padding:"2px 8px",color:t.color,fontWeight:700}}>{t.emoji}×{t.count}</span>
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
                      <Ico name="book" fb="📖" size={16}/>
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
                            ? (item.id.startsWith("gs_")
                                ? (()=>{const b=item.id.replace("gs_","gacha_gs_");return(
                                    <div style={{position:"relative",width:42,height:42,margin:"0 auto",animation:"gsBob 1.6s ease-in-out infinite"}}>
                                      <img src={`/assets/${b}_b.png`} alt={item.name} onError={e=>{const sp=document.createElement("span");sp.textContent=item.emoji;sp.style.cssText="font-size:30px;position:absolute;inset:0;display:flex;align-items:center;justify-content:center;";e.target.replaceWith(sp);}} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain"}}/>
                                    </div>);})()
                                : <img src={`/assets/${item.id.replace("gi_","gacha_").replace("gm_","gacha_gm_")}.png`} alt={item.name} onError={e=>{const sp=document.createElement("span");sp.textContent=item.emoji;sp.style.fontSize="30px";e.target.replaceWith(sp);}} style={{width:38,height:38,objectFit:"contain",borderRadius:6,display:"block",margin:"0 auto"}}/>)
                            : <div style={{fontSize:22,opacity:0.3}}>❓</div>
                          }
                          <div style={{fontSize:11,fontWeight:700,color:cnt>0?(darkBG?"rgba(255,255,255,0.8)":TEXT):MUTED,marginTop:3,lineHeight:1.3}}>{cnt>0?item.name:"???"}</div>
                          {cnt>1&&<div style={{fontSize:11,color:MUTED}}>×{cnt}</div>}
                        </div>);
                      })}
                    </div>
                  )}
                </div>);
              })()}
              {/* 提供割合 */}
              <div style={{marginTop:8,background:darkBG?"rgba(255,255,255,0.04)":CARDS,borderRadius:12,padding:"8px 12px",border:`1px solid ${darkBG?"rgba(255,255,255,0.08)":BORDER}`}}>
                <div style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.35)":MUTED,fontWeight:700,marginBottom:6}}>🎲 提供割合</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {(data.gacha||[]).map(t=>(
                    <div key={t.id} style={{display:"flex",alignItems:"center",gap:4,background:darkBG?"rgba(255,255,255,0.06)":CARD,borderRadius:8,padding:"3px 8px",border:`1px solid ${t.color}40`}}>
                      <span style={{fontSize:11}}>{t.emoji}</span>
                      <span style={{fontSize:11,fontWeight:700,color:t.color}}>{t.label}</span>
                      <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.5)":MUTED}}>{t.rate}%</span>
                      <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.3)":MUTED}}>{t.min}〜{t.max}pt</span>
                    </div>
                  ))}
                </div>
              </div>
            </>);
          })()}
          <style>{`@keyframes glow{0%,100%{box-shadow:0 4px 16px #f5c84260,0 0 0 4px #f5c84225}50%{box-shadow:0 4px 24px #f5c84290,0 0 0 8px #f5c84240}}
          @keyframes gsBlink{0%{opacity:1}49.9%{opacity:1}50%{opacity:0}99.9%{opacity:0}100%{opacity:1}}
          @keyframes gsBlinkB{0%{opacity:0}49.9%{opacity:0}50%{opacity:1}99.9%{opacity:1}100%{opacity:0}}
          @keyframes gsBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}`}</style>
        </div>}
        {/* Junior: ガチャの後はショートカット＆きろくのみ（タスク本体はガチャの前へ移動済み） */}
        {isJunior && <>
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
              {[...myLogs].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).slice(0,3).map(l=>{
                const emoji=l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":l.type==="transfer_in"?"💌":l.type==="transfer_out"?"💸":"⭐";
                return(
                  <div key={l.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"11px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:22}}>{emoji}</span>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{l.label}</div>
                      <div style={{color:MUTED,fontSize:11}}>{fmtDate(l.date)}</div>
                    </div>
                    <Pt v={l.pts}/>
                  </div>
                );
              })}
            </div>
          )}
        </>}
      </>}

      {/* ── ACTIVITY サブナビ ──（投資ワールドが保護者設定でOFFのときは投資/為替タブごと隠す） */}
      {effectiveTab==="activity"&&!isJunior&&!young&&!data.familySettings?.investOff&&(
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
      {effectiveTab==="activity"&&(actTab==="tasks"||young||data.familySettings?.investOff)&&(()=>{
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
              {[...filtGood].sort(sortTaskFn).map(t=>{const pts=taskPts(t,child.id);const on=!!pressed[t.id];const isPending=(data.pendingApprovals||[]).some(p=>p.cid===child.id&&p.taskId===t.id);const cnt=myLogs.filter(l=>l.rid===t.id&&(l.date||"").startsWith(todayISO())).length;return(<button key={t.id} onClick={()=>doTask(t)} style={{background:isPending?GOLDS:on?"#e8faf0":CARD,border:`2.5px solid ${isPending?GOLD:on?G:BORDER}`,borderRadius:18,padding:"13px 10px",cursor:isPending?"default":"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6,transform:on?"scale(.92)":"scale(1)",transition:"all .2s",fontFamily:F,position:"relative"}}>{isPending?<div style={{position:"absolute",top:4,right:4,fontSize:11,background:GOLD,color:"#fff",borderRadius:999,padding:"1px 5px",fontWeight:700}}>確認待ち</div>:cnt>0?<div style={{position:"absolute",top:4,right:4,fontSize:11,background:G,color:"#fff",borderRadius:999,padding:"1px 6px",fontWeight:700}}>✓{cnt}</div>:null}<span style={{fontSize:young?34:26}}>{t.emoji}</span><span style={{fontSize:young?15:12,fontWeight:700,color:TEXT,textAlign:"center"}}>{t.label}</span>{!young&&<Pt v={pts} sz={12}/>}</button>);})}
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
      {effectiveTab==="activity"&&actTab==="invest"&&!young&&!data.familySettings?.investOff&&<InvestTab child={child} data={data} update={update}/>}
      {/* ── KAKEIBO ── */}
      {effectiveTab==="money" && (
        <div style={{padding:"12px 16px 0",display:"flex",gap:6}}>
          {(isJunior
            ?[["goals","🎯 もくひょう"],["rewards","🎁 こうかん"],...(!data.familySettings?.investOff?[["hatake","🌱 はたけ"]]:[])]
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
      {/* ── はたけ（小学生むけ 株だけの投資。為替はInvestTab側で非表示） ── */}
      {effectiveTab==="money" && monTab==="hatake" && isJunior && !data.familySettings?.investOff && <InvestTab child={child} data={data} update={update}/>}
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
                    <div style={{flex:1,minWidth:0}}><div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.label}</div><div style={{color:MUTED,fontSize:11}}>{cat.label} · {fmtDate(e.date)}</div></div>
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
            <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}><Ico name="target" fb="🎯" size={14} style={{marginRight:4}}/>{young?"もくひょう":"貯金目標"}</p>
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
              <div style={{fontSize:11,color:MUTED,marginBottom:6,lineHeight:1.5}}>💡 ポイントは おてつだいで ためて、ごほうびと こうかんできるよ（例：ゲーム1本ぶん ≒ おうちの人ときめてね）</div>
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
            {(data.rewards||[]).map(r=>{
              const ok=myBal>=r.cost;
              return (
                <button key={r.id} onClick={()=>setRewardPop(r)}
                  style={{background:ok?CARD:BG,border:`2.5px solid ${ok?P:BORDER}`,borderRadius:18,padding:"13px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:14,textAlign:"left",fontFamily:F,opacity:ok?1:.55}}>
                  {/^r0\d$/.test(r.id)?<img src={`/assets/reward_${r.id}.png`} style={{width:48,height:48,objectFit:"contain",borderRadius:10,flexShrink:0}} alt=""/>:<span style={{fontSize:34}}>{r.emoji}</span>}
                  <div style={{flex:1}}><div style={{fontWeight:800,fontSize:14}}>{r.label}</div><div style={{color:MUTED,fontSize:12,marginTop:2}}>{r.unit}</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontWeight:900,fontSize:16,color:ok?P:MUTED}}>{r.cost.toLocaleString()}pt</div><div style={{fontSize:11,color:ok?G:R,fontWeight:700}}>{ok?"こうかんできる":"残高不足"}</div></div>
                </button>
              );
            })}
          </div>
          <div style={{marginTop:14,background:"#fef9e0",border:`1.5px solid ${Y}`,borderRadius:14,padding:"11px 14px"}}>
            <p style={{margin:0,fontSize:13,fontWeight:700}}><Ico name="coin" fb="💰" size={15} style={{marginRight:4}}/>いまの残高: <span style={{fontSize:16,color:G}}>{myBal.toLocaleString()}pt</span></p>
          </div>
        </div>
      )}

      {/* ── 図鑑セクション ── */}
      {/* 📊 今週のまとめ(稼ぐ/使う/貯める＝お金の学びの振り返り) */}
      {effectiveTab==="more" && (()=>{
        const wkAgo=(()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString();})();
        const wl=myLogs.filter(l=>(l.date||"")>=wkAgo);
        const earned=wl.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);
        const spent=wl.filter(l=>l.pts<0).reduce((s,l)=>s-l.pts,0);
        const choreCount=wl.filter(l=>l.type==="good"||l.type==="daily").length;
        const net=earned-spent;
        return (
          <div style={{padding:"4px 16px 0"}}>
            <div style={{background:darkBG?"rgba(255,255,255,0.05)":CARD,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderRadius:16,padding:"13px 15px",marginBottom:8}}>
              <div style={{fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.85)":TEXT,marginBottom:10}}>📊 今週のまとめ（7日間）</div>
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <div style={{flex:1,textAlign:"center",background:darkBG?"rgba(52,199,123,0.12)":GS,borderRadius:12,padding:"8px 4px"}}>
                  <div style={{fontSize:10,color:darkBG?"rgba(255,255,255,0.5)":TEXTS,fontWeight:700}}>かせいだ</div>
                  <div style={{fontSize:17,fontWeight:900,color:G}}>+{earned.toLocaleString()}</div>
                </div>
                <div style={{flex:1,textAlign:"center",background:darkBG?"rgba(217,92,85,0.12)":RS,borderRadius:12,padding:"8px 4px"}}>
                  <div style={{fontSize:10,color:darkBG?"rgba(255,255,255,0.5)":TEXTS,fontWeight:700}}>つかった</div>
                  <div style={{fontSize:17,fontWeight:900,color:R}}>-{spent.toLocaleString()}</div>
                </div>
                <div style={{flex:1,textAlign:"center",background:darkBG?"rgba(74,158,255,0.12)":BS,borderRadius:12,padding:"8px 4px"}}>
                  <div style={{fontSize:10,color:darkBG?"rgba(255,255,255,0.5)":TEXTS,fontWeight:700}}>のこり残高</div>
                  <div style={{fontSize:17,fontWeight:900,color:B}}>{myBal.toLocaleString()}</div>
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"space-around",fontSize:11,color:darkBG?"rgba(255,255,255,0.6)":TEXTS,fontWeight:700}}>
                <span>🧹 お手伝い {choreCount}回</span>
                <span>💰 今週ためた {net>=0?"+":""}{net.toLocaleString()}pt</span>
              </div>
              {earned>0 && <div style={{marginTop:8,fontSize:11,color:darkBG?"rgba(255,255,255,0.5)":MUTED,textAlign:"center"}}>{spent<=earned*0.3?"よく がまんして ためたね！🌱":spent>=earned*0.8?"つかいすぎ かも？ためる練習もしよう🐷":"いいバランス！👍"}</div>}
            </div>
          </div>
        );
      })()}

      {effectiveTab==="rpg" && (
        <div style={{padding:"0 16px 0"}}>
          <div onClick={()=>setMoreOpen(o=>o==="zukan"?null:"zukan")}
            style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"12px 14px",cursor:"pointer",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <Ico name="book" fb="📖" size={18}/>
              <span style={{fontSize:13,fontWeight:700,color:TEXT}}>モンスター図鑑</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:11,color:MUTED,fontWeight:700}}>
                {(data.monsterDiscovered?.[child.id]||[]).length}/15
              </span>
              <span style={{fontSize:11,color:MUTED}}>{moreOpen==="zukan"?"▲":"▼"}</span>
            </div>
          </div>
          {moreOpen==="zukan" && <MonsterZukan data={data} child={child}/>}
        </div>
      )}

      {/* ── 背景きせかえ ── */}
      {effectiveTab==="rpg" && (
        <div style={{padding:"0 16px 8px"}}>
          <div onClick={()=>setMoreOpen(o=>o==="bg"?null:"bg")}
            style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"12px 14px",cursor:"pointer",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:18}}>🖼</span>
              <span style={{fontSize:13,fontWeight:700,color:TEXT}}>はいけい きせかえ</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:11,color:MUTED,fontWeight:700}}>
                {BG_THEMES.filter(t=>(t.need||0)<=totalDoneMon).length}/{BG_THEMES.length}
              </span>
              <span style={{fontSize:11,color:MUTED}}>{moreOpen==="bg"?"▲":"▼"}</span>
            </div>
          </div>
          {moreOpen==="bg" && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:4}}>
              {BG_THEMES.map(t=>{
                const unlocked=(t.need||0)<=totalDoneMon;
                const selected=_bgTid===t.id;
                return (
                  <div key={t.id}
                    onClick={()=>{ if(unlocked) update(d=>({...d,bgTheme:{...(d.bgTheme||{}),[child.id]:t.id}})); }}
                    style={{borderRadius:12,overflow:"hidden",cursor:unlocked?"pointer":"default",border:selected?`2.5px solid ${GP}`:`1.5px solid ${BORDER}`,opacity:unlocked?1:0.5}}>
                    <div style={{height:44,background:t.img?`url(${t.img}) center/cover, ${t.grad||"#1a5c8a"}`:(t.grad||"linear-gradient(180deg,#1a5c8a,#1f7038)")}}/>
                    <div style={{padding:"4px 4px",background:CARD,textAlign:"center"}}>
                      <div style={{fontSize:11,fontWeight:700,color:TEXT,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.emoji} {t.name}</div>
                      {!unlocked
                        ? <div style={{fontSize:11,color:MUTED,fontWeight:700}}>🔒 あと{(t.need||0)-totalDoneMon}回</div>
                        : selected
                        ? <div style={{fontSize:11,color:GP,fontWeight:800}}>えらび中</div>
                        : <div style={{fontSize:11,color:MUTED}}>タップで変更</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── 🥚 ヤミノオウのタマゴ: モンスター育成エリア(ヘッダー)に移動済み ── */}

      {/* ── ⚔ ドロップ図鑑(モンスターごとの固有レア武器) ── */}
      {effectiveTab==="rpg" && (()=>{
        const owned=(data.equipUnlock||{})[child.id]||[];
        const rows=[...WILD_MONSTERS,BOSS_MONSTER].map(m=>({m,w:EQUIPMENT.find(it=>it.dropFrom===m.img)})).filter(r=>r.w);
        const gotCount=rows.filter(r=>owned.includes(r.w.id)).length;
        return (
          <div style={{padding:"0 16px 8px"}}>
            <div onClick={()=>setMoreOpen(o=>o==="drops"?null:"drops")}
              style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"12px 14px",cursor:"pointer",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:16}}>⚔</span>
                <span style={{fontSize:13,fontWeight:700,color:TEXT}}>ドロップ図鑑（レア武器）</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:11,color:MUTED,fontWeight:700}}>{gotCount}/{rows.length}</span>
                <span style={{fontSize:11,color:MUTED}}>{moreOpen==="drops"?"▲":"▼"}</span>
              </div>
            </div>
            {moreOpen==="drops" && (
              <div>
                <div style={{fontSize:11,color:MUTED,marginBottom:8,lineHeight:1.5}}>モンスターを倒すと、それぞれ固有のレア武器を低確率でドロップ！周回してコンプを目指そう。</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
                  {rows.map(({m,w})=>{
                    const got=owned.includes(w.id); const rar=EQ_RAR(w.rarity);
                    return (
                      <div key={w.id} style={{borderRadius:12,padding:"10px",background:got?GS:CARD,border:got?`2px solid ${rar.c}`:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",gap:10}}>
                        <div style={{width:40,height:40,borderRadius:10,background:got?"#fff":CARDS,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0,filter:got?"none":"grayscale(1) opacity(.5)"}}>{got?<img src={`/assets/${w.id}.png`} alt="" style={{width:34,height:34,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent=w.e;e.target.replaceWith(s);}}/>:"❓"}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:5}}>
                            <span style={{fontSize:9,fontWeight:900,color:"#fff",background:rar.c,borderRadius:5,padding:"1px 5px"}}>{rar.n}</span>
                            <span style={{fontWeight:800,fontSize:12.5,color:got?TEXT:MUTED,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{got?w.name:"？？？"}</span>
                          </div>
                          {got
                            ? <div style={{fontSize:11,color:B,fontWeight:700,marginTop:2}}>{[w.atk?`⚔+${w.atk}`:"",w.def?`🛡+${w.def}`:"",w.hp?`HP+${w.hp}`:""].filter(Boolean).join(" ")}</div>
                            : <div style={{fontSize:11,color:MUTED,marginTop:2}}>🔒 {m.emoji}{m.name}を 倒すと</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── ひみつのなかま(隠しモンスター) ── */}
      {effectiveTab==="rpg" && (
        <div style={{padding:"0 16px 8px"}}>
          <div onClick={()=>setMoreOpen(o=>o==="hidden"?null:"hidden")}
            style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"12px 14px",cursor:"pointer",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <Ico name="sparkle" fb="✨" size={18}/>
              <span style={{fontSize:13,fontWeight:700,color:TEXT}}>ひみつのなかま</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:11,color:MUTED,fontWeight:700}}>
                {HIDDEN_MONSTERS.filter(h=>hiddenUnlocked(h,data,child,totalDoneMon)).length}/{HIDDEN_MONSTERS.length}
              </span>
              <span style={{fontSize:11,color:MUTED}}>{moreOpen==="hidden"?"▲":"▼"}</span>
            </div>
          </div>
          {moreOpen==="hidden" && (
            <div>
              <div style={{fontSize:11,color:MUTED,marginBottom:8,lineHeight:1.5}}>たくさんクリアすると解放！タップで「すがた」を変えられるよ。</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                {HIDDEN_MONSTERS.map(h=>{
                  const unlocked=hiddenUnlocked(h,data,child,totalDoneMon);
                  const equipped=(data.monsterSkin||{})[child.id]===h.id;
                  return (
                    <div key={h.id}
                      onClick={()=>{ if(unlocked) update(d=>({...d,monsterSkin:{...(d.monsterSkin||{}),[child.id]:equipped?null:h.id}})); }}
                      style={{borderRadius:12,padding:"8px 4px",textAlign:"center",background:equipped?GS:CARD,border:equipped?`2.5px solid ${GP}`:`1.5px solid ${BORDER}`,cursor:unlocked?"pointer":"default",opacity:unlocked?1:0.85}}>
                      {h.sprite
                        ? <div style={{position:"relative",width:50,height:50,margin:"0 auto 3px",filter:unlocked?"none":"brightness(0)"}}>
                            <img src={`/assets/gacha_gs_${h.sprite}_b.png`} alt={unlocked?h.name:"???"} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{e.target.style.visibility="hidden"}}/>
                          </div>
                        : <img src={`/assets/monster_${h.id}_f0.png`} alt={unlocked?h.name:"???"}
                            style={{width:50,height:50,objectFit:"contain",display:"block",margin:"0 auto 3px",imageRendering:"pixelated",filter:unlocked?"none":"brightness(0)"}}
                            onError={e=>{e.target.style.visibility="hidden"}}/>}
                      <div style={{fontSize:11,fontWeight:800,color:unlocked?TEXT:MUTED,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                        {unlocked?h.name:"???"}
                      </div>
                      <div style={{fontSize:11,color:GOLD,fontWeight:700}}>{"★".repeat(h.rarity)}</div>
                      {!unlocked
                        ? <div style={{fontSize:11,color:MUTED,fontWeight:700}}>{h.special==="darkEgg"?"🔒 たまごを育てて":`🔒 あと${h.need-totalDoneMon}回`}</div>
                        : equipped
                        ? <div style={{fontSize:11,color:GP,fontWeight:800}}>すがた中(タップで戻す)</div>
                        : <div style={{fontSize:11,color:MUTED}}>タップですがた変更</div>}
                    </div>
                  );
                })}
              </div>
              <style>{`@keyframes gsBlink{0%{opacity:1}49.9%{opacity:1}50%{opacity:0}99.9%{opacity:0}100%{opacity:1}}
              @keyframes gsBlinkB{0%{opacity:0}49.9%{opacity:0}50%{opacity:1}99.9%{opacity:1}100%{opacity:0}}`}</style>
              {(()=>{const eq=HIDDEN_MONSTERS.find(h=>hiddenUnlocked(h,data,child,totalDoneMon) && (data.monsterSkin||{})[child.id]===h.id);return eq?(
                <div style={{marginTop:8,fontSize:11,color:TEXTS,lineHeight:1.6,background:CARDS,borderRadius:10,padding:"8px 10px"}}>
                  <div style={{fontWeight:800,color:TEXT,marginBottom:2}}>{eq.name}</div>
                  <div>{eq.desc}</div>
                  <div style={{color:B,marginTop:2}}>{eq.edu}</div>
                </div>):null;})()}
            </div>
          )}
        </div>
      )}

      {/* ── うちのこ(猫タネもん) ── */}
      {effectiveTab==="rpg" && (
        <div style={{padding:"0 16px 8px"}}>
          <div onClick={()=>setMoreOpen(o=>o==="cats"?null:"cats")}
            style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"12px 14px",cursor:"pointer",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:18}}>🐱</span>
              <span style={{fontSize:13,fontWeight:700,color:TEXT}}>うちのこ（ねこタネもん）</span>
            </div>
            <span style={{fontSize:11,color:MUTED}}>{moreOpen==="cats"?"▲":"▼"}</span>
          </div>
          {moreOpen==="cats" && (
            <div>
              <div style={{fontSize:11,color:MUTED,marginBottom:8,lineHeight:1.5}}>
                飼い猫モチーフ。タマゴから育てて究極体まで行くと「卒業」して、ランダムで次の猫がやってくるよ🐈
              </div>
              {/* テスト用: 1時間だけ即進化(本番では非表示・開発環境のみ) */}
              {hasCloudStorage() && (() => {
                const until = (data.testEvolveUntil||{})[child.id] || 0;
                const active = until > Date.now();
                const minLeft = Math.max(0, Math.ceil((until-Date.now())/60000));
                return (
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,background:active?BS:CARD,border:`1.5px dashed ${active?B:BORDER}`,borderRadius:12,padding:"8px 10px"}}>
                    <span style={{fontSize:14}}>🧪</span>
                    <div style={{flex:1,fontSize:11,color:TEXTS,fontWeight:700,lineHeight:1.3}}>
                      {active ? `テスト進化ON：あと${minLeft}分（タップで即進化・即卒業）` : "テスト用：1時間だけ即進化できるようにする"}
                    </div>
                    <button onClick={()=>update(d=>({...d, testEvolveUntil:{...(d.testEvolveUntil||{}), [child.id]: active?0:(Date.now()+3600000)}}))}
                      style={{fontSize:11,fontWeight:800,color:"#fff",background:active?MUTED:B,border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontFamily:F,flexShrink:0}}>
                      {active?"OFFにする":"1時間ON"}
                    </button>
                  </div>
                );
              })()}
              {/* 集めた子(卒業した猫) */}
              {(() => {
                const got = (data.collectedMons||{})[child.id] || [];
                if (got.length===0) return null;
                return (
                  <div style={{background:GOLDS,border:`1.5px solid ${GOLD}`,borderRadius:14,padding:"8px 10px",marginBottom:10}}>
                    <div style={{fontSize:11,fontWeight:900,color:GP,marginBottom:6}}>🏅 そつぎょうした子 {got.length}匹</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {got.slice().reverse().map((m,i)=>(
                        <div key={i} style={{textAlign:"center",width:52}}>
                          <img src={`/assets/monster_${m.id}_f0.png`} alt={m.name}
                            style={{width:44,height:44,objectFit:"contain",imageRendering:"pixelated",display:"block",margin:"0 auto"}}
                            onError={e=>{e.target.style.visibility="hidden"}}/>
                          <div style={{fontSize:11,color:TEXTS,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{m.name}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {CAT_LINES.map(cat=>{
                const Cell=({sid,label,big})=>(
                  <div style={{textAlign:"center",flexShrink:0,width:big?64:54}}>
                    <img src={`/assets/monster_${cat.id}_${sid}_f0.png`} alt={label}
                      style={{width:big?56:46,height:big?56:46,objectFit:"contain",imageRendering:"pixelated",display:"block",margin:"0 auto"}}
                      onError={e=>{e.target.style.visibility="hidden"}}/>
                    <div style={{fontSize:7.5,color:TEXTS,fontWeight:700,lineHeight:1.2,marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{label}</div>
                  </div>
                );
                return (
                  <div key={cat.id} style={{background:GS,border:`1.5px solid ${G}40`,borderRadius:14,padding:"10px 8px",marginBottom:10}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6,gap:6}}>
                      <span style={{fontSize:12,fontWeight:900,color:GP}}>{cat.emoji} {cat.name}</span>
                      {(((data.monsterEvolved||{})[child.id]||"").startsWith(cat.id))
                        ? <span style={{fontSize:11,fontWeight:800,color:GP,background:`${G}25`,borderRadius:8,padding:"3px 10px",flexShrink:0}}>🐾 育成中</span>
                        : <button onClick={()=>{ if(typeof window!=="undefined"&&window.confirm(`いまの子をおやすみさせて、${cat.name}をタマゴから育てる？`)) update(d=>({...d, monsterEvolved:{...(d.monsterEvolved||{}),[child.id]:`${cat.id}_egg`}, monsterEvolvedAt:{...(d.monsterEvolvedAt||{}),[child.id]:null}, monsterStageAt:{...(d.monsterStageAt||{}),[child.id]:new Date().toISOString()}, monsterDiscovered:{...(d.monsterDiscovered||{}),[child.id]:[...new Set([...((d.monsterDiscovered||{})[child.id]||[]),`${cat.id}_egg`])]} })); }}
                            style={{fontSize:11,fontWeight:800,color:"#fff",background:G,border:"none",borderRadius:8,padding:"4px 12px",cursor:"pointer",fontFamily:F,flexShrink:0}}>🥚 このこを育てる</button>}
                    </div>
                    {/* 共通の道 */}
                    <div style={{display:"flex",alignItems:"center",gap:2,overflowX:"auto",paddingBottom:4}}>
                      {cat.stages.map((s,i)=>(
                        <React.Fragment key={s.id}>
                          {i>0&&<span style={{color:MUTED,fontWeight:900,fontSize:11}}>▶</span>}
                          <Cell sid={s.id} label={s.label}/>
                        </React.Fragment>
                      ))}
                    </div>
                    {/* 分岐 */}
                    {cat.branches.map((br,bi)=>(
                      <div key={bi} style={{display:"flex",alignItems:"center",gap:4,marginTop:4,paddingLeft:8}}>
                        <span style={{fontSize:11,fontWeight:800,color:br.color,flexShrink:0,width:46}}>└{br.force}</span>
                        {br.stages.map((s,i)=>(
                          <React.Fragment key={s.id}>
                            {i>0&&<span style={{color:MUTED,fontWeight:900,fontSize:11}}>▶</span>}
                            <Cell sid={s.id} label={s.label}/>
                          </React.Fragment>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
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
                  background:(["badges","ranking"].includes(moreOpen)?moreOpen:"log")===k?GP:"transparent",
                  color:(["badges","ranking"].includes(moreOpen)?moreOpen:"log")===k?"#fff":MUTED,
                  fontWeight:(["badges","ranking"].includes(moreOpen)?moreOpen:"log")===k?700:400,fontSize:11,cursor:"pointer",fontFamily:F}}>
                {l}
              </button>
            ))}
          </div>
          {(["badges","ranking"].includes(moreOpen)?moreOpen:"log")==="log" && (
          <div>
          <div style={{marginBottom:12}}><SortBar options={[["new","新しい順"],["old","古い順"],["pts_high","pt高い順"],["pts_low","pt低い順"]]} value={logSort} onChange={setLogSort}/></div>
          {myLogs.length===0 && <p style={{color:MUTED,textAlign:"center",marginTop:20}}>まだきろくがないよ</p>}
          {[...myLogs].sort((a,b)=>logSort==="new"?(b.date||"").localeCompare(a.date||""):logSort==="old"?(a.date||"").localeCompare(b.date||""):logSort==="pts_high"?b.pts-a.pts:a.pts-b.pts).slice(0,50).map(l=>{
            const emoji=l.type==="transfer_out"?"💸":l.type==="transfer_in"?"💌":l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":l.type==="interest"?"💹":l.type==="invest_buy"?"📈":l.type==="invest_sell"?"📉":l.type==="tips"?"💡":([...(data.goodTasks||[]),...(data.badTasks||[])].find(t=>t.id===l.rid)?.emoji||"📌");
            const canDelete=l.type!=="gacha"&&!(l.label||"").startsWith("🗑 取り消し:");
            return <LogRow key={l.id} l={l} emoji={emoji} canDelete={canDelete} child={child} update={update} showFlash={showFlash}/>;
          })}
          </div>
          )}
        </div>
      )}

      {/* ── BADGES ── */}
      {effectiveTab==="more"&&(["badges","ranking"].includes(moreOpen)?moreOpen:"log")==="badges"&&<BadgesSection child={child} data={data} update={update}/>}

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
                <Ico name="trophy" fb="🏆" size={16}/>
                <span style={{fontSize:12,fontWeight:700,color:TEXT}}>今月の活動ランキング</span>
              </div>
              <div style={{fontSize:11,color:MUTED,marginBottom:12}}>残高・投資損益は含みません。今月の活動ptで比較</div>
              {rank.length===0&&<p style={{color:MUTED,textAlign:"center",padding:"16px 0"}}>参加メンバーがいません</p>}
              {rank.map((r,i)=>(
                <div key={r.member.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<rank.length-1?`1px solid ${BORDER}`:"none"}}>
                  <div style={{width:26,height:26,borderRadius:8,background:i===0?GOLDS:i===1?CARDS:BG,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,flexShrink:0}}>{MEDAL[i]||r.rank}</div>
                  <ChildAvatar child={r.member} size={32}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{r.member.name}</div>
                    <div style={{fontSize:11,color:MUTED}}>🔥 {r.streak}日連続</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontWeight:800,fontSize:14,color:G}}>+{r.pts}pt</div>
                    <div style={{fontSize:11,color:MUTED}}>今月</div>
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
    const t = todayISO();
    if(!s.active) return "off";
    if(s.startDate && t < s.startDate) return "pending";
    if(s.endDate   && t > s.endDate)   return "expired";
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

  // 最大4セットを同時アクティブにトグル(5つ目を選ぶと一番古い選択が外れる)
  const toggleActive = id => update(d=>{
    const cur = Array.isArray(d.activeSetIds) ? d.activeSetIds.filter(x=>(d.dailyTaskSets||[]).some(s=>s.id===x)) : (d.activeSetId?[d.activeSetId]:[]);
    let next;
    if (cur.includes(id)) next = cur.filter(x=>x!==id);     // 解除
    else next = [...cur, id].slice(-4);                      // 追加(最大4・古いものから押し出し)
    if (next.length===0) next = [id];                        // 最低1つは残す
    return {...d, activeSetIds: next, activeSetId: next[0],
      dailyTaskSets:(d.dailyTaskSets||[]).map(s=>next.includes(s.id)?{...s,active:true}:s)};
  });

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
      const activeIds=Array.isArray(data.activeSetIds)&&data.activeSetIds.length?data.activeSetIds:[data.activeSetId];
      const isActive=activeIds.includes(s.id);
      const isOpen=selSetId===s.id;
      return(<div key={s.id} style={{background:CARD,border:`2px solid ${isActive?G:isOpen?B:BORDER}`,borderRadius:18,marginBottom:10,overflow:"hidden"}}>

        {/* セットヘッダー */}
        <div style={{padding:"12px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22,flexShrink:0}}>{s.emoji}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:14,color:TEXT}}>{s.name}</div>
            <div style={{display:"flex",gap:8,marginTop:2,flexWrap:"wrap"}}>
              <span style={{fontSize:11,fontWeight:700,color:statusColor[status]}}>{statusLabel[status]}</span>
              <span style={{fontSize:11,color:MUTED}}>{s.tasks.length}タスク · ボーナス{s.bonus}pt</span>
              {s.startDate&&<span style={{fontSize:11,color:MUTED}}>{s.startDate}〜{s.endDate||"無期限"}</span>}
            </div>
          </div>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            {/* アクティブ切替（最大2つ同時。タップでON/OFF） */}
            {!isActive&&<button onClick={()=>toggleActive(s.id)}
              style={{padding:"4px 10px",background:`${G}15`,border:`1.5px solid ${G}`,borderRadius:8,color:G,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
              ＋使う
            </button>}
            {isActive&&<button onClick={()=>toggleActive(s.id)}
              style={{padding:"4px 10px",background:`${G}30`,border:`1.5px solid ${G}`,borderRadius:8,color:G,fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F}}>使用中✓</button>}
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
                    <div style={{flex:1}}><p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>pt</p><input value={editDt.pts} onChange={e=>setEditDt(v=>({...v,pts:e.target.value}))} type="number" style={INP}/></div>
                    {editDt.type==="count"&&<div style={{flex:1}}><p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>目標回数</p><input value={editDt.target} onChange={e=>setEditDt(v=>({...v,target:e.target.value}))} type="number" style={INP}/></div>}
                  </div>
                  <div style={{display:"flex",gap:6}}><Btn c={G} label="保存" onClick={()=>saveTaskEdit(s.id)} sm/><Btn c={MUTED} label="キャンセル" onClick={()=>setEditDt(null)} sm/></div>
                </div>
                :<div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:18,flexShrink:0}}>{t.emoji}</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13}}>{t.label}</div>
                    <div style={{color:MUTED,fontSize:11}}>{t.type==="check"?"✅":"🔢"} +{t.pts}pt{t.type==="count"&&` · 目標${t.target||1}回`}</div>
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
                      <div style={{flex:1}}><div style={{fontWeight:700,fontSize:12}}>{t.label}</div><div style={{color:MUTED,fontSize:11}}>+{t.pts}pt</div></div>
                      <span style={{color:G,fontSize:16,fontWeight:900}}>+</span>
                    </button>
                  ))}
                </div>
              ):(
                <div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}><input value={nd.emoji} onChange={e=>setNd(v=>({...v,emoji:e.target.value}))} style={{...INP,width:50}}/><input value={nd.label} onChange={e=>setNd(v=>({...v,label:e.target.value}))} placeholder="タスク名" style={INP}/></div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>{[["check","✅"],["count","🔢"]].map(([x,l])=><button key={x} onClick={()=>setNd(v=>({...v,type:x}))} style={{flex:1,padding:"5px 0",border:`2px solid ${nd.type===x?G:BORDER}`,borderRadius:8,background:nd.type===x?`${G}15`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:nd.type===x?G:MUTED}}>{l}</button>)}</div>
                  <div style={{display:"flex",gap:6,marginBottom:8}}>
                    <div style={{flex:1}}><p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>pt</p><input value={nd.pts} onChange={e=>setNd(v=>({...v,pts:e.target.value}))} type="number" style={INP}/></div>
                    {nd.type==="count"&&<div style={{flex:1}}><p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>目標回数</p><input value={nd.target} onChange={e=>setNd(v=>({...v,target:e.target.value}))} type="number" style={INP}/></div>}
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
                <PromptModalButton btnLabel="🎁 付与" title={`${child.name}に ボーナスpt`} desc={`${s.name} のごほうび。何ポイント あげる？`} type="number" maxLen={4} initial={String((data.childDailyBonus||{})[child.id]??s.bonus)} placeholder="pt"
                  btnStyle={{padding:"3px 8px",background:`${Y}20`,border:`1px solid ${Y}`,borderRadius:7,color:"#9a7000",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}
                  onSubmit={(val)=>{ const amt=parseInt(val); if(!isNaN(amt)&&amt>0){const _e={id:uid(),cid:child.id,type:"grant",label:`🌟 ボーナスpt（${s.name}）`,pts:amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);} }}/>
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

  // 本番(Vercel)ではAPIキー無しの直接呼び出しが401になるため機能を停止。
  // 子どもの行動データを外部AIへ送る導線でもあり、サーバ経由化するまで「準備中」を表示
  if(!hasCloudStorage()){
    return (
      <div style={{textAlign:"center",padding:"40px 20px"}}>
        <div style={{fontSize:48,marginBottom:10}}>🤖</div>
        <div style={{fontWeight:900,fontSize:16,color:TEXT,marginBottom:6}}>AI分析はじゅんび中です</div>
        <p style={{color:MUTED,fontSize:13,lineHeight:1.8,maxWidth:300,margin:"0 auto"}}>
          家族のがんばりをAIが分析してアドバイスする機能を準備しています。もうしばらくお待ちください！
        </p>
      </div>
    );
  }

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
    if(!hasCloudStorage())return; // 二重ガード: 本番では外部AIへ送信しない（UIゲートと独立に保証）
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
              <div style={{color:MUTED,fontSize:11}}>{new Date().toLocaleDateString("ja-JP")} 生成</div>
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
          <div style={{fontSize:11,color:MUTED,marginTop:3}}>手数料：{sub==="stocks"?"売買2%":"売買0.5%"}</div>
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
          <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13,color:TEXT}}>{s.name}</div><div style={{fontSize:11,color:MUTED}}>{s.ticker}</div></div>
          <div style={{textAlign:"right"}}>
            <div style={{fontWeight:700,fontSize:14,color:TEXT}}>{s.price?.toLocaleString()}{s.currency==="JPY"?"円":"$"}</div>
            <div style={{fontSize:11,fontWeight:600,color:(s.lastChange||0)>=0?G:R}}>{(s.lastChange||0)>=0?"+":""}{(s.lastChange||0).toFixed(1)}%</div>
            {s.realData===false&&<div style={{fontSize:11,color:R,fontWeight:700}}>サンプル値</div>}
          </div>
        </div>
      ))}
      {/* 為替一覧 */}
      {sub==="forex"&&Object.values(forex).map((fx,i)=>(
        <div key={i} style={{background:CARD,borderRadius:14,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          <div style={{width:36,height:36,borderRadius:10,background:"#E5F0FF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{fx.flag}</div>
          <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13,color:TEXT}}>{fx.name||fx.code}</div><div style={{fontSize:11,color:MUTED}}>1 {fx.code} = ¥{(fx.price||0).toFixed(fx.code==="KRW"?3:2)}</div></div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,fontWeight:600,color:(fx.changePct||0)>=0?G:R}}>{(fx.changePct||0)>=0?"+":""}{(fx.changePct||0).toFixed(2)}%</div>
            {fx.realData?<div style={{fontSize:11,color:G,fontWeight:600}}>LIVE</div>:<div style={{fontSize:11,color:R,fontWeight:700}}>サンプル値</div>}
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
              <div style={{marginTop:8,fontSize:11,color:"rgba(255,255,255,0.45)"}}>🎁 {fs.familyMission?.reward||"達成報酬"} · 活動・お手伝いのみ対象</div>
            </div>
          );
        })()}

        {/* 活動ランキング */}
        {metric!=="operation_return_rate"&&(
          <div style={{background:CARD,borderRadius:18,padding:"16px",boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <Ico name="trophy" fb="🏆" size={16}/>
                <span style={{fontSize:11,fontWeight:700,color:TEXT}}>{METRICS.find(m=>m[0]===metric)?.[1]}ランキング</span>
              </div>
              <span style={{fontSize:11,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:600}}>
                {metric==="approved_activity_points"?"今月の活動pt":metric==="streak"?"継続日数":"目標達成"}
              </span>
            </div>
            <div style={{fontSize:11,color:MUTED,marginBottom:12}}>残高・投資損益は含みません</div>
            {actRank.map((r,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<actRank.length-1?`1px solid ${BORDER}`:"none"}}>
                <div style={{width:26,height:26,borderRadius:8,background:i===0?GOLDS:i===1?CARDS:BG,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,flexShrink:0}}>{MEDAL[i]||i+1}</div>
                <ChildAvatar child={r.member} size={32}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{r.member.name}</div>
                  <div style={{fontSize:11,color:MUTED}}>🔥 {r.streak}日連続</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:800,fontSize:14,color:G}}>+{r.pts}pt</div>
                  <div style={{fontSize:11,color:MUTED}}>今月</div>
                </div>
              </div>
            ))}
            <div style={{marginTop:10,padding:"7px 12px",background:BG,borderRadius:10,display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:11}}>🔒</span>
              <span style={{fontSize:11,color:MUTED}}>残高・目標は本人と管理者のみ閲覧</span>
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
            <div style={{background:"#E5F0FF",borderRadius:9,padding:"7px 10px",marginBottom:12,fontSize:11,color:"#3478D4"}}>
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
                      ?<div style={{fontSize:11,color:MUTED}}>元本{r.op.cost}pt</div>
                      :<div style={{fontSize:11,color:MUTED,display:"flex",alignItems:"center",gap:3}}>🔒 損益のみ公開</div>
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
    if(!txGuard("grant2_"+grantChild.id)) return;   // 連打ガード(二重付与防止)
    (()=>{const _e={id:uid(),cid:grantChild.id,type:"grant",label:grantLabel||"おこづかい",pts:amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);})();
    setGrantChild(null); setGrantAmt(""); setGrantLabel("おこづかい");
  };

  const addChild = () => {
    if(!ncName||ncPin.length!==4)return;
    const newId=uid();
    update(d=>({...d,children:[...d.children,{id:newId,name:ncName,emoji:ncEmoji,pinh:pinHash(ncPin),ageMode:ncMode}],pinChanged:{...(d.pinChanged||{}),[newId]:true}}));
    setShowAddChild(false); setNcName(""); setNcEmoji("😊"); setNcPin(""); setNcMode("middle");
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
          <Emo e={child.emoji} size={22}/>
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
          <button onClick={()=>setTab("children")} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,boxShadow:"0 2px 8px rgba(24,35,29,0.05)"}}><Ico name="gear" fb="⚙" size={18}/></button>
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
                    <div style={{color:"rgba(255,255,255,0.45)",fontSize:11}}>現在のタネ</div>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"flex-end",gap:6,marginBottom:10}}>
                  <div style={{color:"#fff",fontSize:40,fontWeight:900,lineHeight:1,letterSpacing:-1}}>{pBal.toLocaleString()}</div>
                  <div style={{color:"rgba(255,255,255,0.65)",fontSize:14,fontWeight:600,marginBottom:5}}>pt</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:12,fontWeight:700,color:pDelta>=0?"#86efac":"#fca5a5"}}>{pDelta>=0?"+":""}{pDelta.toLocaleString()}pt</span>
                  <span style={{fontSize:11,color:"rgba(255,255,255,0.45)"}}>今月</span>
                  {pStreak>=3&&<div style={{display:"flex",alignItems:"center",gap:3,background:"rgba(255,255,255,0.12)",padding:"3px 8px",borderRadius:999}}>
                    <span style={{fontSize:11,color:"#fff",fontWeight:600}}>🔥 {pStreak}日連続</span>
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
                <Emo e={child.emoji} size={34}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:15}}>{child.name} <span style={{background:`${P}20`,color:P,fontSize:11,fontWeight:700,padding:"2px 6px",borderRadius:8}}>{AGE_MODES[child.ageMode||"middle"].label}</span></div>
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
                  <Emo e={child.emoji} size={24}/>
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
                      <p style={{color:MUTED,fontSize:11,margin:"0 0 4px"}}>絵文字 / アバター（写真がない場合）</p>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <input value={(editChild.emoji||"").startsWith("ico:")?"":editChild.emoji} placeholder="絵文字" onChange={e=>setEditChild(c=>({...c,emoji:e.target.value}))} style={{...INP,width:60}}/>
                        {editChild.avatar&&<button onClick={()=>setEditChild(c=>({...c,avatar:undefined}))}
                          style={{padding:"5px 9px",border:`1px solid ${R}`,borderRadius:8,background:"transparent",color:R,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>
                          写真を削除
                        </button>}
                      </div>
                      <p style={{color:MUTED,fontSize:11,margin:"8px 0 4px"}}>ドット絵アバターから選ぶ</p>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        {["dad","mom","boy","girl","toddler","baby","grandpa","grandma"].map(av=>{
                          const sel=editChild.emoji===`ico:${av}`;
                          return <button key={av} onClick={()=>setEditChild(c=>({...c,emoji:`ico:${av}`}))}
                            style={{width:42,height:42,borderRadius:10,border:`2px solid ${sel?GP:BORDER}`,background:sel?GS:CARD,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",padding:0}}>
                            <Ico name={av} size={32}/>
                          </button>;
                        })}
                      </div>
                    </div>
                  </div>
                  <input value={editChild.name} onChange={e=>setEditChild(c=>({...c,name:e.target.value}))} placeholder="なまえ" style={{...INP,marginBottom:8}}/>
                  <input value={editChild.pin} onChange={e=>setEditChild(c=>({...c,pin:e.target.value.slice(0,4)}))} type="number" placeholder="新しい暗証番号（変更する時だけ入力）" style={{...INP,marginBottom:8}}/>
                  {(editChild.pin||"").length>0&&(editChild.pin||"").length!==4 && <p style={{color:R,fontSize:11,margin:"0 0 8px"}}>4けたで入力してください</p>}
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
                        style={{flex:1,padding:"7px 4px",border:`2px solid ${editChild.ageMode===k?P:BORDER}`,borderRadius:10,background:editChild.ageMode===k?`${P}20`:"transparent",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,color:editChild.ageMode===k?P:MUTED}}>
                        {v.emoji}<br/>{v.label}
                      </button>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:8}}>{sb(G,"保存",()=>{
                    const np=(editChild.pin||"");
                    if(np.length>0&&np.length!==4)return;
                    const {pin,...rest}=editChild;
                    const saved=np.length===4?{...rest,pinh:pinHash(np)}:rest;
                    // lockEnabledをdataにも反映
                    update(d=>({...d,
                      children:d.children.map(c=>c.id===editChild.id?saved:c),
                      lockEnabled:{...(d.lockEnabled||{}),[editChild.id]:!!editChild.lockEnabled},
                      ...(np.length===4?{pinChanged:{...(d.pinChanged||{}),[editChild.id]:true}}:{})
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
                    <div style={{display:"flex",gap:6}}>{sb(B,"✏",()=>setEditChild({...child,pin:"",lockEnabled:!!(data.lockEnabled&&data.lockEnabled[child.id])}))}
                    {sb(R,"🗑",()=>setDelChild(child.id))}</div>
                  </div>
                  <div style={{background:BG,borderRadius:10,padding:"7px 12px",display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:14}}>🔐</span>
                    <span style={{color:MUTED,fontSize:11,fontWeight:700}}>暗証番号ロック:</span>
                    <span style={{fontWeight:800,fontSize:12,color:data.lockEnabled&&data.lockEnabled[child.id]?G:MUTED}}>
                      {data.lockEnabled&&data.lockEnabled[child.id]?"ON":"OFF（ロックなし）"}
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
                    style={{flex:1,padding:"7px 4px",border:`2px solid ${ncMode===k?P:BORDER}`,borderRadius:10,background:ncMode===k?`${P}20`:"transparent",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,color:ncMode===k?P:MUTED}}>
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
                    <Emo e={child.emoji} size={20}/>
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
                          <button onClick={()=>setOverModal({task:{...task,over:{...(task.over||{})}},kind})} style={{background:`${P}18`,border:`1px solid ${P}`,borderRadius:7,padding:"3px 7px",color:P,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>個別</button>
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
              <Emo e={child.emoji} size={32}/>
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
                          <p style={{color:MUTED,fontSize:11,margin:"0 0 3px"}}>{lbl}</p>
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
                <Emo e={child.emoji} size={26}/>
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
                <p style={{fontWeight:800,fontSize:13,color:MUTED,marginBottom:8}}><Emo e={child.emoji} size={13} style={{marginRight:3}}/>{child.name}　<span style={{color:G}}>{bal(data.logs,child.id).toLocaleString()}pt</span></p>
                {logs.map(l=>{
                  const emoji=l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":([...data.goodTasks,...data.badTasks].find(t=>t.id===l.rid)?.emoji||"📌");
                  return (
                    <div key={l.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 13px",marginBottom:6,display:"flex",alignItems:"center",gap:10}}>
                      <span style={{fontSize:17}}>{emoji}</span>
                      <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{l.label}</div><div style={{color:MUTED,fontSize:11}}>{fmtDate(l.date)}</div></div>
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
  const [showDash, setShowDash] = useState(false);   // 親ダッシュボード(今日/今週)の折りたたみ
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
    pin: !parentPinIsDefault(data),
    tasks: !!(data.onboardingChecks?.tasksOpened),
    rewards: !!(data.onboardingChecks?.rewardsOpened),
  };
  const onboardRemaining = Object.values(onboardChecks).filter(v=>!v).length;
  const showOnboard = data.setupComplete === true && onboardRemaining > 0;
  const pendCount = (data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length;

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:32}}>
      {/* ヘッダー */}
      <div style={{padding:"52px 20px 12px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:40,height:40,borderRadius:12,background:GP,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,boxShadow:`0 4px 12px ${GP}40`}}>🌱</div>
            <div>
              <div style={{fontFamily:FB,fontWeight:900,fontSize:19,color:GP,letterSpacing:.5}}>Tane Money</div>
              <div style={{fontSize:11,color:MUTED,letterSpacing:.3}}>お金は、未来を育てるタネ。</div>
            </div>
          </div>
          <button onClick={()=>setShowSettings(true)}
            style={{width:38,height:38,borderRadius:11,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",boxShadow:"0 2px 8px rgba(24,35,29,0.05)",position:"relative"}}>
            ⚙
            {parentPinIsDefault(data)&&<div style={{position:"absolute",top:-4,right:-4,width:10,height:10,borderRadius:"50%",background:R,border:"2px solid #fff"}}/>}
          </button>
        </div>
      </div>

      {/* 未承認だけは緊急性が高いので 上部に細いアラートで残す */}
      {pendCount>0 && (
        <div onClick={()=>setShowSettings(true)} style={{margin:"0 20px 12px",background:RS,border:`1.5px solid ${R}`,borderRadius:12,padding:"9px 14px",display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
          <span style={{fontSize:16}}>🔔</span>
          <span style={{flex:1,fontSize:13,fontWeight:800,color:R}}>みしょうにんが {pendCount}けん あります</span>
          <span style={{fontSize:12,color:R,fontWeight:700}}>かくにん ›</span>
        </div>
      )}

      <div style={{padding:"0 20px"}}>
        <div style={{fontSize:15,fontWeight:800,color:TEXT,marginBottom:12}}>だれの ページを ひらく？</div>
        {/* 子ども */}
        <div style={{fontSize:13,fontWeight:800,color:MUTED,letterSpacing:.5,marginBottom:10}}>おこさま</div>
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
                    <span style={{fontSize:11,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:600}}>こども</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,color:MUTED}}>{member.gradeLabel||"中高生"}</span>
                    <span style={{fontSize:11,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:700}}>累計 {bal(data.logs,member.id).toLocaleString()}pt</span>
                    {(()=>{const td=todayDelta(member.id);return td>0&&<span style={{fontSize:11,background:GOLDS,color:GOLD,padding:"2px 7px",borderRadius:999,fontWeight:700}}>今日 +{td}pt</span>;})()}
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
          <div style={{fontSize:13,fontWeight:800,color:MUTED,letterSpacing:.5,margin:"16px 0 10px"}}>おうちのかた</div>
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
                <span style={{fontSize:11,background:CARDS,color:TEXTS,padding:"2px 7px",borderRadius:999,fontWeight:600}}>おとな</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:MUTED}}>子ども {childCount}人</span>
                <span style={{fontSize:11,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:700}}>今月計 {monthTotal.toLocaleString()}pt</span>
              </div>
            </div>
            <ChevronRightIcon/>
          </button>
          );
        })}

        {/* 📊 おうちの方へ：今日のようす・今週のまとめ(折りたたみ＝メンバーを優先) */}
        {data.children&&data.children.length>0 && (()=>{
          const td=todayKey();
          const kids=data.children||[];
          const didToday=kids.filter(c=>(data.logs||[]).some(l=>l.cid===c.id&&(l.type==="good"||l.type==="daily")&&(l.date||"").startsWith(td)));
          const gachaLeft=kids.filter(c=>(data.gachaDate?.[c.id])!==td);
          const wkAgo=(()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString();})();
          return (
            <div style={{marginTop:20}}>
              <button onClick={()=>setShowDash(v=>!v)} style={{width:"100%",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"12px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",fontFamily:F}}>
                <span style={{fontSize:13,fontWeight:800,color:TEXT}}>📊 おうちの方へ（今日・今週のまとめ）</span>
                <span style={{fontSize:12,color:MUTED}}>{showDash?"▲":"▼"}</span>
              </button>
              {showDash && (<>
                <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"14px 16px",boxShadow:SHADOW,marginTop:10}}>
                  <div style={{fontSize:12,fontWeight:800,color:MUTED,marginBottom:10,letterSpacing:.5}}>📋 きょうの ようす</div>
                  <div style={{display:"flex",alignItems:"stretch",gap:8}}>
                    <div onClick={()=>pendCount>0&&setShowSettings(true)} style={{flex:1,textAlign:"center",cursor:pendCount>0?"pointer":"default"}}>
                      <div style={{fontSize:24,fontWeight:900,color:pendCount>0?R:TEXT,lineHeight:1.1}}>{pendCount}</div>
                      <div style={{fontSize:12,color:MUTED,fontWeight:700,marginTop:2}}>みしょうにん{pendCount>0?" 👆":""}</div>
                    </div>
                    <div style={{width:1,background:BORDER}}/>
                    <div style={{flex:1,textAlign:"center"}}>
                      <div style={{fontSize:24,fontWeight:900,color:G,lineHeight:1.1}}>{didToday.length}<span style={{fontSize:13,color:MUTED,fontWeight:700}}>/{kids.length}</span></div>
                      <div style={{fontSize:12,color:MUTED,fontWeight:700,marginTop:2}}>きょう おてつだい</div>
                    </div>
                    <div style={{width:1,background:BORDER}}/>
                    <div style={{flex:1,textAlign:"center"}}>
                      <div style={{fontSize:24,fontWeight:900,color:gachaLeft.length>0?GOLD:MUTED,lineHeight:1.1}}>{gachaLeft.length}</div>
                      <div style={{fontSize:12,color:MUTED,fontWeight:700,marginTop:2}}>ガチャ まだ</div>
                    </div>
                  </div>
                  {gachaLeft.length>0 && <div style={{fontSize:11,color:MUTED,marginTop:10,paddingTop:8,borderTop:`1px solid ${BORDER}`,lineHeight:1.5}}>🎰 まだの子：<b style={{color:"#9a7000"}}>{gachaLeft.map(c=>c.name).join("、")}</b></div>}
                </div>
                <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"14px 16px",boxShadow:SHADOW,marginTop:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
                    <span style={{fontSize:12,fontWeight:800,color:MUTED,letterSpacing:.5}}>📊 今週のまとめ（7日間）</span>
                    <span style={{fontSize:10,color:MUTED}}>かせいだ・つかった・🧹回数</span>
                  </div>
                  {data.children.map((c,idx)=>{
                    const wl=(data.logs||[]).filter(l=>l.cid===c.id&&(l.date||"")>=wkAgo);
                    const earned=wl.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);
                    const spent=wl.filter(l=>l.pts<0).reduce((s,l)=>s-l.pts,0);
                    const chores=wl.filter(l=>l.type==="good"||l.type==="daily").length;
                    return (
                      <div key={c.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderTop:idx===0?"none":`1px solid ${BORDER}`}}>
                        <ChildAvatar child={c} size={30}/>
                        <span style={{flex:1,fontSize:13,fontWeight:700,color:TEXT,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</span>
                        <span style={{fontSize:12,color:G,fontWeight:900,minWidth:54,textAlign:"right"}}>+{earned.toLocaleString()}</span>
                        <span style={{fontSize:12,color:R,fontWeight:900,minWidth:48,textAlign:"right"}}>-{spent.toLocaleString()}</span>
                        <span style={{fontSize:12,color:MUTED,fontWeight:800,minWidth:30,textAlign:"right"}}>🧹{chores}</span>
                      </div>
                    );
                  })}
                </div>
              </>)}
            </div>
          );
        })()}

        {/* 同期 */}
        <div style={{marginTop:20,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",background:CARD,borderRadius:12,border:`1px solid ${BORDER}`}}>
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
            <span style={{fontSize:11,fontWeight:800,color:GP,lineHeight:1.3,textAlign:"center"}}>初心者<br/>ガイド</span>
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
              <p style={{color:MUTED,fontSize:11,fontWeight:600,margin:"0 0 3px",letterSpacing:.5}}>かぞくコード</p>
              <p style={{fontWeight:800,fontSize:15,color:TEXT,margin:0,letterSpacing:2.5}}>
                {(()=>{try{return localStorage.getItem("tane_money_family_code")||"---";}catch(e){return "---";}})()}
              </p>
            </div>
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
    if (target==="parent") update(d=>{const{parentPin,...rest}=d;return{...rest,parentPinH:pinHash(newPin)};});
    else update(d=>({...d,children:d.children.map(c=>c.id===target?(({pin,...r})=>({...r,pinh:pinHash(newPin)}))(c):c),pinChanged:{...(d.pinChanged||{}),[target]:true}}));
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
  if(!data.interestEnabled||!data.interestRate) return;
  const today=todayKey();
  // 付与判定・残高計算・付与日記録をすべて update の中(最新のd)で原子的に行う＝
  // 多重呼び出し/再マウント/同期巻き戻しでも二重付与されない
  update(d=>{
    if(!d.interestEnabled||!d.interestRate) return d;
    const last=(d.interestLastDate||{})[cid];
    if(last===today) return d;                       // 同日は付与済み
    if(last){
      const diff=(new Date(today.replace(/-/g,'/'))-new Date(last.replace(/-/g,'/')))/86400000;
      if(diff<7) return d;                            // 前回から7日未満はスキップ(週次)
    }
    const cur=bal(d.logs,cid);
    if(cur<=0) return d;
    const interest=Math.floor(cur*d.interestRate);
    if(interest<=0) return d;
    const _e={id:uid(),cid,type:"interest",label:`💹 週次利子（残高×${Math.round(d.interestRate*100)}%）`,pts:interest,date:new Date().toISOString()};
    addLogToFirestore(_e);
    return {...d, logs:[_e,...d.logs], interestLastDate:{...(d.interestLastDate||{}),[cid]:today}};
  });
}

// ── 配当（毎週・控えめ週0.3〜0.5%）。株価変動より小さく＝「持てば必ず増える」誤学習をしない健全設計 ─────
// 実データの株価は短期だと横ばい＋手数料で利益が出にくいので、保有報酬を厚くして"長期で増える"を実感できるように
function applyHoldingBonus(data,update,cid){
  const week=Math.floor(Date.now()/(7*86400000));  // 週単位で支払い
  if((data.holdings||{})[cid]==null || !((data.holdings||{})[cid]||[]).length) return;
  const toPts=(s,p)=>s.currency==="USD"?Math.max(1,Math.round(p*1.5)):Math.max(1,Math.round(p/100));
  const now=Date.now();
  // 付与判定・記録を update の中(最新のd)で原子的に＝二重付与しない
  update(d=>{
    if((d.holdBonusLastDate||{})[cid]===week) return d;   // 今週は付与済み
    const holdings=(d.holdings||{})[cid]||[];
    if(!holdings.length) return d;
    const stocks=d.stocks||[];
    let totalBonus=0;
    holdings.forEach(h=>{
      const st=stocks.find(x=>x.id===h.stockId);
      if(!st) return;
      const days=h.firstBuyDate?(now-new Date(h.firstBuyDate).getTime())/86400000:0;
      // 配当: 週0.3%(長く持つと少しだけUP・上限0.5%)。株価の値動きより小さい＝「持てば必ず増える」わけではない(健全な投資観)
      const rate = days>=90?0.005 : days>=30?0.004 : 0.003;
      totalBonus+=Math.round(toPts(st,st.price)*h.qty*rate);
    });
    if(totalBonus<=0) return d;
    const _e={id:uid(),cid,type:"interest",label:`💰 配当（株を持っていると もらえる）`,pts:totalBonus,date:new Date().toISOString()};
    addLogToFirestore(_e);
    return {...d, logs:[_e,...d.logs], holdBonusLastDate:{...(d.holdBonusLastDate||{}),[cid]:week}};
  });
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
// ── 🥚 ヤミノオウのタマゴ 育成カード(待機アニメ＋お世話リアクション＋ハッチ進化演出) ──
function DarkEggCard({child,data,update}){
  const eg=data.darkEgg?.[child.id]||{care:0};
  const care=eg.care||0;
  const st=darkEggStage(care);
  const stIdx=DARK_EGG_STAGES.indexOf(st);
  const isFinal=care>=DARK_EGG_MAX;
  const tISO=todayISO();
  const fedToday=eg.last===tISO;
  const nextMin=DARK_EGG_STAGES.find(s=>s.min>care)?.min ?? DARK_EGG_MAX;
  const [react,setReact]=useState(false);   // お世話リアクション(揺れ＋キラキラ)
  const [evo,setEvo]=useState(null);        // 進化演出 {from,to}
  const [showTree,setShowTree]=useState(false);  // 進化図
  const vib=p=>{try{navigator.vibrate(p);}catch(e){}};
  // ステージ別の待機アニメ: たまご=ゆらゆら / ベビー=ぴょこぴょこ / 王=ふわふわ＋発光
  const idleAnim = react ? "deShake .5s ease-in-out" : isFinal ? "deFloat 3s ease-in-out infinite" : stIdx===0 ? "deWob 2.6s ease-in-out infinite" : "deHop 1.4s ease-in-out infinite";
  const feed=()=>{
    if(isFinal||react||fedToday) return;   // 期間ゲート: お世話は1日1回(ほかのタネモンと同様にじっくり育てる)
    const newCare=care+1; const newSt=darkEggStage(newCare);
    setReact(true); vib(20); setTimeout(()=>setReact(false),650);
    if(DARK_EGG_STAGES.indexOf(newSt)>stIdx){    // ステージ上昇=ハッチ/進化演出
      setEvo({from:st,to:newSt}); vib([30,50,30,80]); setTimeout(()=>setEvo(null),2600);
    }
    update(d=>{ const e=d.darkEgg?.[child.id]||{care:0}; return {...d, darkEgg:{...(d.darkEgg||{}),[child.id]:{care:(e.care||0)+1,last:tISO}}}; });
  };
  // ── 転生/リセット: 育て切ったヤミノオウをタマゴに戻してもう一度育てられる(基礎ステ+1%が永続) ──
  const reraise=()=>{
    if(!isFinal) return;
    if(typeof window!=="undefined" && !window.confirm("ヤミノオウを 転生させる？\nもう一度タマゴから 育てられるよ。基礎ステータスが +1% 永続アップ！")) return;
    update(d=>({...d,
      darkEgg:{...(d.darkEgg||{}),[child.id]:{care:0,last:""}},
      eggDrops:{...(d.eggDrops||{}),[child.id]:((d.eggDrops?.[child.id])||0)+1},
    }));
    vib([30,50,30,80]);
  };
  const Sprite=({sprite,emoji,size:sz=64})=>(
    <div style={{position:"relative",width:sz,height:sz,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <img src={`/assets/gacha_gs_${sprite}_b.png`} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{e.target.style.visibility="hidden";const fb=e.target.parentNode.querySelector(".de-fb");if(fb)fb.style.display="flex";}}/>
      <span className="de-fb" style={{display:"none",position:"absolute",inset:0,alignItems:"center",justifyContent:"center",fontSize:sz*0.6}}>{emoji}</span>
    </div>
  );
  return (
    <div style={{padding:"0 16px 8px"}}>
      <div style={{position:"relative",overflow:"hidden",background:"linear-gradient(135deg,#2a1f4a,#3d2b66)",border:`1.5px solid ${isFinal?"#e8b83e":"#7b61c9"}`,borderRadius:16,padding:"13px 15px",color:"#fff"}}>
        {/* 背景のうごめく闇/光オーラ */}
        <div style={{position:"absolute",top:-30,right:-30,width:120,height:120,borderRadius:"50%",background:isFinal?"radial-gradient(circle,#e8b83e55,transparent 70%)":"radial-gradient(circle,#b07bff44,transparent 70%)",animation:"dePulse 3s ease-in-out infinite",pointerEvents:"none"}}/>
        <div style={{position:"relative",display:"flex",alignItems:"center",gap:12}}>
          <div style={{position:"relative",width:64,height:64,flexShrink:0,animation:idleAnim,filter:isFinal?"drop-shadow(0 0 8px #e8b83eaa)":"none"}}>
            <Sprite sprite={st.sprite} emoji={st.emoji} size={64}/>
            {react && [0,1,2,3,4].map(i=>(
              <span key={i} style={{position:"absolute",left:"50%",top:"50%",fontSize:13,"--r":`${i*72}deg`,animation:"deSpark .65s ease-out forwards",transform:`rotate(${i*72}deg) translateY(-28px)`,opacity:0}}>✨</span>
            ))}
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              <span style={{fontWeight:900,fontSize:15}}>{st.emoji} {st.name}</span>
              <span style={{fontSize:9,fontWeight:800,color:"#d9ccff",background:"rgba(255,255,255,0.14)",borderRadius:5,padding:"1px 6px"}}>{st.stage}</span>
              {isFinal&&<span style={{fontSize:9,fontWeight:900,color:"#2a1f4a",background:"#e8b83e",borderRadius:5,padding:"1px 5px"}}>かんせい</span>}
            </div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:2,lineHeight:1.5}}>{st.desc}</div>
            <div style={{height:8,borderRadius:999,background:"rgba(255,255,255,0.15)",overflow:"hidden",marginTop:7}}>
              <div style={{height:"100%",width:`${Math.min(100,Math.round(care/DARK_EGG_MAX*100))}%`,background:"linear-gradient(90deg,#b07bff,#e8b83e)",borderRadius:999,transition:"width .5s"}}/>
            </div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.55)",marginTop:3}}>お世話 {care}/{DARK_EGG_MAX}{!isFinal&&` ・ つぎの すがたまで あと${nextMin-care}`}</div>
          </div>
        </div>
        {isFinal
          ? <>
              <div style={{marginTop:10,fontSize:11.5,color:"#ffe9a8",fontWeight:800,textAlign:"center"}}>✨ かんせい！「ひみつのなかま」で すがたに できるよ！</div>
              <button onClick={reraise} style={{marginTop:8,width:"100%",background:"linear-gradient(135deg,#818cf8,#6366f1)",border:"none",borderRadius:12,padding:"10px",color:"#fff",fontWeight:900,fontSize:13,cursor:"pointer",fontFamily:F}}>🔄 転生させて もう一度 育てる（基礎+1%）</button>
            </>
          : <><button onClick={feed} disabled={react||fedToday} style={{position:"relative",marginTop:10,width:"100%",background:fedToday?"rgba(255,255,255,0.12)":"linear-gradient(135deg,#7b61c9,#b07bff)",border:"none",borderRadius:12,padding:"11px",color:"#fff",fontWeight:900,fontSize:14,cursor:fedToday?"default":"pointer",fontFamily:F,opacity:(react||fedToday)?0.7:1}}>{fedToday?"🌙 きょうは おしまい（またあした）":"🤚 お世話する（1日1回）"}</button>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",textAlign:"center",marginTop:6,lineHeight:1.5}}>毎日 1回 お世話して じっくり育てよう。※育てている間は いつものモンスターの進化が ゆっくり(1.5倍)になるよ</div></>}
        {/* 進化図トグル */}
        <button onClick={()=>setShowTree(v=>!v)} style={{marginTop:8,width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.18)",borderRadius:10,padding:"8px",color:"#d9ccff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>🔍 進化図を{showTree?"とじる":"みる"}</button>
        {showTree && (
          <div style={{marginTop:8,background:"rgba(0,0,0,0.22)",borderRadius:12,padding:"10px 8px"}}>
            {DARK_EGG_STAGES.map((s,i)=>{
              const reached=care>=s.min, current=s===st;
              return (
                <div key={s.sprite} style={{display:"flex",alignItems:"center",gap:10,padding:"5px 6px",borderRadius:10,background:current?"rgba(232,184,62,0.18)":"transparent"}}>
                  <div style={{width:40,height:40,flexShrink:0,filter:reached?"none":"grayscale(1) brightness(.45)",opacity:reached?1:0.7}}>
                    <Sprite sprite={s.sprite} emoji={s.emoji} size={40}/>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:800,color:reached?"#fff":"rgba(255,255,255,0.5)"}}>
                      {reached?s.name:"？？？"} <span style={{fontSize:9,fontWeight:800,color:"#d9ccff",background:"rgba(255,255,255,0.12)",borderRadius:5,padding:"1px 5px",marginLeft:2}}>{s.stage}</span>
                    </div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",marginTop:1}}>お世話 {s.min}回〜{current?"（いまここ）":reached?" ✓":""}</div>
                  </div>
                  {i<DARK_EGG_STAGES.length-1 && <span style={{color:"rgba(255,255,255,0.3)",fontSize:12}}>↓</span>}
                </div>
              );
            })}
          </div>
        )}
        {/* ── 進化(ハッチ)演出オーバーレイ ── */}
        {evo && (
          <div style={{position:"absolute",inset:0,background:"radial-gradient(circle,#fff 0%,#3d2b66 60%)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",animation:"deEvoBg 2.6s ease-out forwards",zIndex:5}}>
            <div style={{display:"flex",alignItems:"center",gap:10,animation:"deEvoPop .6s ease-out"}}>
              <div style={{animation:"deEvoOut .9s ease-in forwards"}}><Sprite sprite={evo.from.sprite} emoji={evo.from.emoji} size={50}/></div>
              <span style={{fontSize:22,color:"#e8b83e"}}>➡</span>
              <div style={{animation:"deEvoIn .9s .5s ease-out both",filter:"drop-shadow(0 0 10px #e8b83e)"}}><Sprite sprite={evo.to.sprite} emoji={evo.to.emoji} size={62}/></div>
            </div>
            <div style={{marginTop:8,fontWeight:900,fontSize:16,color:"#3d2b66",animation:"deEvoText .9s .6s both",textShadow:"0 1px 0 #fff"}}>✨ しんか！ {evo.to.name}！</div>
            {[...Array(10)].map((_,i)=>(
              <span key={i} style={{position:"absolute",left:`${10+i*8}%`,top:"50%",fontSize:14,animation:`deBurst 1.1s ${0.4+i*0.04}s ease-out forwards`,opacity:0}}>{i%2?"⭐":"✨"}</span>
            ))}
          </div>
        )}
        <style>{`
          @keyframes deWob{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}
          @keyframes deHop{0%,100%{transform:translateY(0)}40%{transform:translateY(-7px)}60%{transform:translateY(-4px)}}
          @keyframes deFloat{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-5px) scale(1.04)}}
          @keyframes deShake{0%,100%{transform:translate(0,0) rotate(0)}20%{transform:translate(-3px,1px) rotate(-7deg)}40%{transform:translate(3px,-2px) rotate(7deg)}60%{transform:translate(-2px,1px) rotate(-5deg)}80%{transform:translate(2px,0) rotate(4deg)}}
          @keyframes deBlink{0%,49.9%{opacity:1}50%,99.9%{opacity:0}100%{opacity:1}}
          @keyframes deBlinkB{0%,49.9%{opacity:0}50%,99.9%{opacity:1}100%{opacity:0}}
          @keyframes dePulse{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:.9;transform:scale(1.15)}}
          @keyframes deSpark{0%{opacity:1}100%{opacity:0;transform:rotate(var(--r)) translateY(-44px) scale(.4)}}
          @keyframes deEvoBg{0%{opacity:0}12%{opacity:1}80%{opacity:1}100%{opacity:0}}
          @keyframes deEvoPop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}
          @keyframes deEvoOut{0%{opacity:1}100%{opacity:0;transform:scale(.5) translateX(-8px)}}
          @keyframes deEvoIn{0%{opacity:0;transform:scale(.4)}60%{transform:scale(1.25)}100%{opacity:1;transform:scale(1)}}
          @keyframes deEvoText{0%{opacity:0;transform:translateY(8px) scale(.8)}100%{opacity:1;transform:translateY(0) scale(1)}}
          @keyframes deBurst{0%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-60px) scale(.3)}}
        `}</style>
      </div>
    </div>
  );
}

function SeedMonster({ child, data, size=90, update }) {
  const [sparkles, setSparkles] = useState([]);
  const [speech, setSpeech] = useState(null);
  const [editNick, setEditNick] = useState(false);
  const [nickInput, setNickInput] = useState("");
  const [evolving, setEvolving] = useState(false);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    // 100ms刻みの共通カウンタ。6コマ持ち=300ms送り/2コマ=500ms送りに換算(90=両周期の公倍数)
    const t = setInterval(() => setFrame(f => (f + 1) % 90), 100);
    return () => clearInterval(t);
  }, []);

  // デジモン風: 横にウロウロ歩く（前向き絵のまま左右移動＋進む向きに反転）
  const [walkX, setWalkX] = useState(0);
  const [face, setFace] = useState(1);
  const walkRef = useRef(0);
  useEffect(() => {
    if (evolving) { setWalkX(0); walkRef.current = 0; return; }
    const id = setInterval(() => {
      const nx = Math.round((Math.random() * 2 - 1) * 34);
      // 横向きスプライトは素が左向き。右へ進むときは反転(-1)しないと後ろ歩きに見える
      setFace(nx >= walkRef.current ? -1 : 1);
      walkRef.current = nx;
      setWalkX(nx);
    }, 2200);
    return () => clearInterval(id);
  }, [evolving]);

  const myBal      = bal(data.logs, child.id);
  const curStreak  = data.streak?.[child.id]?.cur || 0;
  const maxStreak  = (data.streak||{})[child.id]?.max || 0;
  const thisMonth  = new Date().toISOString().slice(0,7);
  const monthPts   = (data.logs||[]).filter(l=>l.cid===child.id&&(l.date||"").startsWith(thisMonth)&&l.pts>0).reduce((s,l)=>s+l.pts,0);
  const goalsDone  = (data.goals||[]).filter(g=>g.cid===child.id&&g.done).length;
  const todayDone  = data.gachaDate?.[child.id] === todayKey();

  const myLogs         = (data.logs||[]).filter(l=>l.cid===child.id);
  const totalTasksDone = myLogs.filter(l=>l.type==="good"||l.type==="daily").length;
  const goodCount      = myLogs.filter(l=>l.type==="good").length;
  const badgeCount     = myLogs.filter(l=>l.type==="badge").length;
  const lifetimePts    = myLogs.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);

  // ── 進化状態（時間ゲート＋育てた度ゲージの二重条件）──
  const mon            = getMonState(data, child);
  const currentStageId = mon.curId === "egg" ? null : mon.curId;
  const evolved        = !!currentStageId;
  const monDef         = mon.def;
  const monsterId      = mon.curId;
  const curStage       = mon.stage;
  const isFinal        = mon.isFinal;
  const isEgg          = monsterId==="egg" || /_egg$/.test(String(monsterId));  // 卵は「しんか」でなく「うまれる」
  const canEvolve      = mon.canEvolve && !!update;
  // 隠しモンスターの「すがた(スキン)」を装備していれば表示を上書き(進化は裏で継続)
  const skinId         = (data.monsterSkin||{})[child.id] || null;
  const skinDef        = skinId ? HIDDEN_MONSTERS.find(h=>h.id===skinId) : null;
  const skinActive     = !!(skinDef && hiddenUnlocked(skinDef,data,child,totalTasksDone) && child.displayMode !== "junior");
  const dispId         = skinActive ? skinId : monsterId;
  // 前向き多コマアニメ: m系=6コマ, 猫=4コマ(ぴょこぴょこ)。それ以外は従来の横向き2コマ
  const isCat          = /^(cpurin|cku|cshi)_/.test(String(dispId));
  const frontFrames    = MON_FRAMES6[dispId] ? 6 : isCat ? 4 : 0;
  const multiFront     = frontFrames > 0;   // 前向き多コマ(歩行はするが左右反転しない)
  // タマゴの進化中は「ハッチ演出」: 自身のコマ(バウンド→光る→ヒビ)を高速再生
  const hatching       = evolving && monsterId === "egg";
  const fIdx           = hatching ? (3 + Math.floor(frame/2) % 3)
                       : multiFront ? Math.floor(frame / 3) % frontFrames
                       : Math.floor(frame / 5) % 2;
  // どうぶつ仲間スキン＆ヤミノオウ系統(MONSTER_TREE.gs)は gacha_gs_*_a/b の2コマで表示
  const gsSkin         = skinActive ? (skinDef && skinDef.sprite ? skinDef.sprite : null) : (monDef && monDef.gs ? monDef.gs : null);
  // ── 怠けもん退化(一時的): 最後の接触(なでなで or タスク)から24時間で"怠けもん"に変身。なでなで/タスクで即もとに戻る・進化や育てた度は失わない ──
  const _careRec    = (data.monsterCare||{})[child.id]||{};
  const _caredToday = _careRec.last === todayKey();
  const _careTs     = _careRec.ts || 0;
  const _taskTs     = myLogs.reduce((mx,l)=>((l.type==="good"||l.type==="daily")?Math.max(mx,new Date(l.date).getTime()||0):mx),0);
  const _lastTouch  = Math.max(_careTs,_taskTs);
  const neglected   = !evolving && !hatching && monsterId!=="egg" && !_caredToday && _lastTouch>0 && (Date.now()-_lastTouch >= 86400000);
  // 全コマを重ねて常時マウントし、表示コマだけvisibilityで切替(src差し替えのデコード点滅を防止)
  const _nFront = hatching ? 6 : frontFrames;
  const frameList = neglected
    ? [`/assets/monster_neglect_a.png`,`/assets/monster_neglect_b.png`]
    : gsSkin
    ? [`/assets/gacha_gs_${gsSkin}_a.png`,`/assets/gacha_gs_${gsSkin}_b.png`]
    : (multiFront || hatching)
    ? Array.from({length:_nFront},(_,i)=>`/assets/monster_${dispId}_f${i}.png`)
    : [`/assets/monster_${dispId}_side_f0.png`,`/assets/monster_${dispId}_side_f1.png`];
  const activeFrameIdx = (neglected || gsSkin) ? (Math.floor(frame/6)%2) : fIdx;

  // 進化先を分岐ルールで決定（egg→m01→m02→[系統分岐]→…→究極体）
  // 分岐は乱数なしの固定ルール=「子どもの行動」で決まる(図鑑のbranchHintと必ず一致させること)
  //   1. 目標を1つ達成       → c系統(まなび)   ※意思が一番はっきり出る行動を最優先
  //   2. 最高れんぞく7日     → a系統(森)
  //   3. 貯金残高1000以上    → b系統(たから)
  //   4. どれも未達          → a系統(デフォルト=毎日タッチで誰でも届く森)
  const computeNextStageId = () => {
    const def = MONSTER_TREE[mon.curId] || MONSTER_TREE["egg"];
    if (def.branch) {
      const b = def.branch;
      if (b.length >= 3) {           // 3分岐(m系): まなび>森>たから>default森
        if (goalsDone >= 1)  return b[2];  // c まなび(目標)
        if (maxStreak >= 7)  return b[0];  // a 森(継続)
        if (myBal >= 1000)   return b[1];  // b たから(貯金)
        return b[0];
      }
      // 2分岐(猫): [0]=森の力(継続) / [1]=星の力(目標)
      if (goalsDone >= 1)  return b[1];   // 星の力(目標達成)
      if (maxStreak >= 7)  return b[0];   // 森の力(継続7日)
      return b[0];
    }
    return def.evolveTo || null;
  };

  // 転生（究極体の4日後に可能）
  const reincCount     = (data.reincarnationCount||{})[child.id] || 0;
  const canReincarnate = mon.canReincarnate && evolved && !evolving && !!update;

  const happyScore = Math.min(10,
    (curStreak>=7?3:curStreak>=3?2:curStreak>=1?1:0) +
    (monthPts>=500?3:monthPts>=200?2:monthPts>=50?1:0) +
    (goalsDone>=2?2:goalsDone>=1?1:0) +
    (todayDone?1:0) + (myBal>=1000?1:0)
  );

  const tapMsgs = evolving
    ? ["しんかちゅう…！"]
    : happyScore>=7
    ? ["わーい！✨","うれしい〜！","ありがとう！","えへへ〜！"]
    : happyScore>=4
    ? ["いっしょにがんばろ！","きょうもよろしく！","タスクやってみよ！"]
    : ["さびしいな…","がんばって！","タッチしてくれた！"];

  const handleTap = () => {
    if (evolving) return;
    // なでなで(お世話)を1日1回だけ育てた度に加算
    if (update) {
      const today = todayKey();
      if (((data.monsterCare||{})[child.id]||{}).last !== today) {
        update(d => {
          const c = (d.monsterCare||{})[child.id] || {};
          if (c.last === today) return d;
          // なでなで(1日1回)でHPも回復
          return careMon({...d, monsterCare: {...(d.monsterCare||{}), [child.id]: {days:(c.days||0)+1, last:today, ts:Date.now()}}}, child.id, 0.3, 5);
        });
      }
    }
    const id = Date.now();
    setSparkles(s=>[...s,{id,x:Math.random()*60-30,y:-(20+Math.random()*30)}]);
    setTimeout(()=>setSparkles(s=>s.filter(x=>x.id!==id)),800);
    setSpeech(tapMsgs[Math.floor(Math.random()*tapMsgs.length)]);
    setTimeout(()=>setSpeech(null),1800);
  };

  const genIV = () => ({
    hp:  Math.floor(Math.random()*10)+1,
    atk: Math.floor(Math.random()*10)+1,
    def: Math.floor(Math.random()*10)+1,
    spd: Math.floor(Math.random()*10)+1,
  });

  const doEvolve = () => {
    if ((!canEvolve && !mon.testEvolve) || evolving) return;   // テスト中はcanEvolve判定を待たず進化
    setEvolving(true);
    setSpeech(null);
    const nextId = computeNextStageId();
    if (!nextId) { setEvolving(false); return; }
    const iv = genIV();
    const now = new Date().toISOString();
    setTimeout(() => {
      update(d => {
        const disc = [...new Set([...(d.monsterDiscovered?.[child.id]||[]), nextId])];
        return {
          ...d,
          monsterEvolved:    {...(d.monsterEvolved||{}),    [child.id]: nextId},
          monsterEvolvedAt:  {...(d.monsterEvolvedAt||{}),  [child.id]: now},
          monsterStageAt:    {...(d.monsterStageAt||{}),    [child.id]: now},
          monsterIV:         {...(d.monsterIV||{}),         [child.id]: iv},
          monsterDiscovered: {...(d.monsterDiscovered||{}), [child.id]: disc},
        };
      });
    }, 1600);
    const wasEgg = monsterId === "egg";
    setTimeout(() => {
      setEvolving(false);
      setSpeech(wasEgg ? "うまれたよ！🐣✨" : "しんかしたよ！🌟");
      setTimeout(()=>setSpeech(null),2500);
    }, 2400);
  };

  const doReincarnate = () => {
    if (!canReincarnate || evolving) return;
    const until = new Date(Date.now() + 7*24*60*60*1000).toISOString();
    update(d => {
      const prevLv = monLevel((d.monsterExp||{})[child.id]||0).lv;   // 今までのレベルを永続パワーに変換
      return {
        ...d,
        monsterEvolved:       {...(d.monsterEvolved||{}),       [child.id]: null},
        monsterEvolvedAt:     {...(d.monsterEvolvedAt||{}),     [child.id]: null},
        monsterStageAt:       {...(d.monsterStageAt||{}),       [child.id]: new Date().toISOString()},
        monsterExp:           {...(d.monsterExp||{}),           [child.id]: 0},   // レベルは1に戻す
        monsterLevelSeen:     {...(d.monsterLevelSeen||{}),     [child.id]: 1},
        reincPower:           {...(d.reincPower||{}),           [child.id]: ((d.reincPower||{})[child.id]||0)+prevLv},  // 到達Lvを永続加算(0.5%/Lv)
        reincarnationCount:   {...(d.reincarnationCount||{}),   [child.id]: ((d.reincarnationCount||{})[child.id]||0)+1},
        reincarnationBonus:   {...(d.reincarnationBonus||{}),   [child.id]: {until, rate:0.05}},
      };
    });
    setSpeech("てんせい！レベルは1に戻るけど 永続パワーGET✨");
    setTimeout(()=>setSpeech(null),3000);
  };

  // 卒業：猫を育て切ったら「うちのこ」に加え、ランダムで次の猫タマゴをむかえる
  const doGraduate = () => {
    if (!canReincarnate || evolving) return;
    const species = String(monsterId).split("_")[0];   // cpurin / cku
    const entry = { species, id: monsterId, name: monDef.name, rarity: monDef.rarity||5, date: new Date().toISOString() };
    // 直前と違う猫を優先してランダム抽選
    const pool = CAT_LINES.filter(c => c.id !== species);
    const cands = pool.length ? pool : CAT_LINES;
    const next = cands[Math.floor(Math.random()*cands.length)];
    update(d => ({
      ...d,
      collectedMons:    {...(d.collectedMons||{}),    [child.id]: [...((d.collectedMons||{})[child.id]||[]), entry]},
      monsterEvolved:   {...(d.monsterEvolved||{}),   [child.id]: `${next.id}_egg`},
      monsterEvolvedAt: {...(d.monsterEvolvedAt||{}), [child.id]: null},
      monsterStageAt:   {...(d.monsterStageAt||{}),   [child.id]: new Date().toISOString()},
      monsterDiscovered:{...(d.monsterDiscovered||{}),[child.id]: [...new Set([...((d.monsterDiscovered||{})[child.id]||[]), `${next.id}_egg`])]},
    }));
    setSpeech(`🎓そつぎょう！${next.emoji}あたらしいタマゴが届いたよ✨`);
    setTimeout(()=>setSpeech(null),3200);
  };

  // タマゴからやり直す(別の進化を試せる。やり直し回数で分岐が変わる)
  const doRehatch = () => {
    if (evolving) return;
    update(d => ({
      ...d,
      monsterEvolved:   {...(d.monsterEvolved||{}),   [child.id]: null},
      monsterEvolvedAt: {...(d.monsterEvolvedAt||{}), [child.id]: null},
      monsterStageAt:   {...(d.monsterStageAt||{}),   [child.id]: new Date().toISOString()},
      rehatchCount:     {...(d.rehatchCount||{}),     [child.id]: ((d.rehatchCount||{})[child.id]||0)+1},
    }));
    setSpeech("タマゴにもどったよ！🥚");
    setTimeout(()=>setSpeech(null),2200);
  };

  // タネモン変化: 含み益(上がってる=正義)ではなく「長く持てている=辛抱」を称える(射幸性カット/健全)
  const _invH=(data.holdings||{})[child.id]||[];
  const _invHeldMax=_invH.reduce((mx,h)=>{const d=h.firstBuyDate?(Date.now()-new Date(h.firstBuyDate).getTime())/86400000:0;return d>mx?d:mx;},0);
  const invThriving = _invHeldMax>=30;   // 30日以上 持ち続けている相棒は ほんのり光る＋🌳バッジ
  const accessories = [
    invThriving      ? {emoji:"🌳",bg:GS,   pos:{top:16,right:-8}}   : null,
    goodCount>=100   ? {emoji:"🏆",bg:GOLDS,pos:{top:-6,right:-6}}  : null,
    maxStreak>=7     ? {emoji:"⚡",bg:BS,   pos:{top:-6,left:-6}}   : null,
    badgeCount>=5    ? {emoji:"📚",bg:PS,   pos:{bottom:6,left:-6}} : null,
    myBal>=5000      ? {emoji:"💎",bg:BS,   pos:{bottom:6,right:-6}}: null,
  ].filter(Boolean).slice(0,4);

  const evoPct       = mon.growthPct;
  const evoRemaining = mon.growthRemain;
  const nickname  = (data.monsterNickname||{})[child.id];
  const dispName  = nickname || (skinActive ? skinDef.name : monDef.name);
  const rarityStr = "★".repeat((skinActive ? skinDef.rarity : monDef.rarity) || 1);
  const monLv = monLevel((data.monsterExp||{})[child.id]||0).lv;

  return (
    <div style={{position:"relative",flexShrink:0,textAlign:"center"}}>
      {/* スパークル */}
      {sparkles.map(sp=>(
        <div key={sp.id} style={{position:"absolute",top:"40%",left:"50%",transform:`translate(${sp.x}px,${sp.y}px)`,fontSize:12,pointerEvents:"none",zIndex:50,animation:"smSparkle 0.8s ease-out forwards"}}>✨</div>
      ))}
      {/* 進化バーストエフェクト */}
      {evolving && [0,45,90,135,180,225,270,315].map((deg,i)=>(
        <div key={deg} style={{position:"absolute",top:"40%",left:"50%",width:0,height:0,pointerEvents:"none",zIndex:50}}>
          <div style={{position:"absolute",fontSize:i%2===0?16:12,animation:`smSparkle ${0.5+i*0.06}s ease-out infinite`,transform:`rotate(${deg}deg) translateY(${-40-i*4}px)`}}>
            {["⭐","✨","🌟"][i%3]}
          </div>
        </div>
      ))}

      {/* ふきだし */}
      {speech&&(
        <div style={{position:"absolute",bottom:"100%",left:"50%",transform:"translateX(-50%)",marginBottom:6,background:"#fff",border:`2px solid ${G}`,borderRadius:14,padding:"6px 12px",fontSize:12,fontWeight:800,color:TEXT,whiteSpace:"nowrap",boxShadow:"0 4px 18px rgba(24,35,29,0.18)",zIndex:10,animation:"smPop .25s cubic-bezier(.34,1.56,.64,1)",pointerEvents:"none"}}>
          {speech}
          <div style={{position:"absolute",top:"100%",left:"50%",transform:"translateX(-50%)",width:0,height:0,borderLeft:"7px solid transparent",borderRight:"7px solid transparent",borderTop:`8px solid ${G}`}}/>
        </div>
      )}

      {/* サボり中のふきだし(構ってよ〜) */}
      {neglected && !speech && (
        <div style={{position:"absolute",bottom:"100%",left:"50%",transform:"translateX(-50%)",marginBottom:6,background:"#fff",border:"2px solid #b08130",borderRadius:14,padding:"6px 12px",fontSize:12,fontWeight:800,color:"#7a5a00",whiteSpace:"nowrap",boxShadow:"0 4px 18px rgba(24,35,29,0.18)",zIndex:10,animation:"smPop .25s cubic-bezier(.34,1.56,.64,1)",pointerEvents:"none"}}>
          くさ〜い…おせわして！
          <div style={{position:"absolute",top:"100%",left:"50%",transform:"translateX(-50%)",width:0,height:0,borderLeft:"7px solid transparent",borderRight:"7px solid transparent",borderTop:"8px solid #b08130"}}/>
        </div>
      )}

      {/* モンスター画像（デジモン風に横移動） */}
      <div style={{transform:`translateX(${walkX}px) scaleX(${multiFront?1:face})`,transition:"transform 1.8s ease-in-out",willChange:"transform"}}>
        <div style={{animation:evolving?"none":"monFloat 2.5s ease-in-out infinite"}} onClick={handleTap}>
          <div style={{
            animation:hatching?"shk 0.3s ease-in-out infinite":evolving?"evoFlash 0.35s ease-in-out infinite":"monBreathe 3.5s ease-in-out infinite",
            cursor:"pointer",display:"inline-block",userSelect:"none",position:"relative",
            filter:hatching?"none":evolving?"brightness(2.5) saturate(0.2)":(invThriving?"drop-shadow(0 0 7px rgba(52,199,123,.85))":"none"),  // ハッチ中はヒビを見せる/投資好調はほんのり緑に光る
            transition:"filter 0.4s",
          }}>
            <div style={{position:"relative",width:size,height:size}}>
              {frameList.map((src,i)=>(
                <img key={src} src={src} alt={i===activeFrameIdx?dispName:""} style={{position:"absolute",inset:0,width:size,height:size,objectFit:"contain",imageRendering:"pixelated",visibility:i===activeFrameIdx?"visible":"hidden"}}
                  onError={e=>{const t=e.target;const s=t.dataset.fb||"0";if(s==="0"){t.dataset.fb="1";t.src=`/assets/monster_${dispId}_f0.png`;}else if(s==="1"){t.dataset.fb="2";t.src="/assets/monster_egg_f0.png";}else{t.style.visibility="hidden";}}}/>
              ))}
            </div>
            {accessories.map((acc,i)=>(
              <div key={i} style={{position:"absolute",...acc.pos,background:acc.bg,borderRadius:"50%",width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,boxShadow:"0 2px 6px rgba(0,0,0,0.18)",border:"1.5px solid rgba(255,255,255,0.9)"}}>{acc.emoji}</div>
            ))}
            {neglected && <span style={{position:"absolute",top:-4,right:-4,fontSize:Math.round(size*0.22),animation:"neglFly 1.4s ease-in-out infinite",pointerEvents:"none"}}>🪰</span>}
            {neglected && <span style={{position:"absolute",top:-12,left:4,fontSize:Math.round(size*0.2),opacity:.75,animation:"neglStink 1.9s ease-in-out infinite",pointerEvents:"none"}}>💨</span>}
          </div>
        </div>
        <div style={{width:50,height:8,borderRadius:"50%",background:"rgba(0,0,0,0.15)",margin:"-4px auto 0",animation:"monShadow 2.5s ease-in-out infinite"}}/>
      </div>

      {/* 名前＋レア度 */}
      {update ? (
        editNick ? (
          <div style={{marginTop:4}}>
            <input value={nickInput} onChange={e=>setNickInput(e.target.value)}
              onBlur={()=>{update(d=>({...d,monsterNickname:{...(d.monsterNickname||{}),[child.id]:nickInput.trim()||null}}));setEditNick(false);}}
              onKeyDown={e=>{if(e.key==="Enter"){update(d=>({...d,monsterNickname:{...(d.monsterNickname||{}),[child.id]:nickInput.trim()||null}}));setEditNick(false);}if(e.key==="Escape")setEditNick(false);}}
              autoFocus maxLength={8} placeholder={skinActive?skinDef.name:monDef.name}
              style={{fontSize:12,border:"1.5px solid rgba(255,255,255,0.5)",borderRadius:8,padding:"3px 8px",textAlign:"center",width:80,fontFamily:"inherit",color:"#fff",background:"rgba(255,255,255,0.15)",outline:"none"}}
            />
          </div>
        ) : (
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:3,marginTop:2}}>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.9)",fontWeight:800}}>
              {dispName}
              <span style={{fontSize:11,fontWeight:800,color:"#3aa0d8",marginLeft:4,background:"rgba(122,224,255,0.18)",borderRadius:6,padding:"0 5px"}}>Lv.{monLv}</span><span style={{fontSize:11,color:"rgba(255,220,100,0.8)",marginLeft:4}}>{rarityStr}</span>{skinActive&&<span onClick={(e)=>{e.stopPropagation();update&&update(d=>({...d,monsterSkin:{...(d.monsterSkin||{}),[child.id]:null}}));}} title="タップで すがたを外す" style={{fontSize:11,color:"#1a1024",background:"rgba(255,255,255,0.9)",borderRadius:6,padding:"0 7px",marginLeft:5,fontWeight:900,cursor:"pointer"}}>👕すがた ✕</span>}
              {reincCount>0&&<span style={{fontSize:11,color:"rgba(160,200,255,0.9)",marginLeft:3}}>転{reincCount}</span>}
            </div>
            <button onClick={()=>{setNickInput(nickname||"");setEditNick(true);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:"rgba(255,255,255,0.45)",padding:0,lineHeight:1}}>✏</button>
          </div>
        )
      ) : (
        <div style={{fontSize:11,color:"rgba(255,255,255,0.88)",fontWeight:800,marginTop:2,letterSpacing:0.3}}>
          {dispName}
          <span style={{fontSize:11,fontWeight:800,color:"#3aa0d8",marginLeft:4,background:"rgba(122,224,255,0.18)",borderRadius:6,padding:"0 5px"}}>Lv.{monLv}</span><span style={{fontSize:11,color:"rgba(255,220,100,0.8)",marginLeft:4}}>{rarityStr}</span>{skinActive&&<span onClick={(e)=>{e.stopPropagation();update&&update(d=>({...d,monsterSkin:{...(d.monsterSkin||{}),[child.id]:null}}));}} title="タップで すがたを外す" style={{fontSize:11,color:"#1a1024",background:"rgba(255,255,255,0.9)",borderRadius:6,padding:"0 7px",marginLeft:5,fontWeight:900,cursor:"pointer"}}>👕すがた ✕</span>}
        </div>
      )}

      {/* 進化バー or 最終形バッジ */}
      {!isFinal && (
        <>
          <div style={{width:90,height:3,background:"rgba(255,255,255,0.18)",borderRadius:999,margin:"4px auto 0",overflow:"hidden"}}>
            <div style={{height:"100%",width:`${evoPct}%`,background:canEvolve?"linear-gradient(90deg,#fde68a,#f59e0b)":"rgba(255,255,255,0.72)",borderRadius:999,transition:"width 0.6s ease"}}/>
          </div>
          {!canEvolve && (
            <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",fontWeight:700,marginTop:3}}>
              {!mon.growthOk ? `あと${evoRemaining}で${isEgg?"うまれる":"しんか"}✨` : `⏳ ${fmtTimeRemain(mon.timeRemainMs)}で${isEgg?"うまれる":"しんか"}`}
            </div>
          )}
        </>
      )}
      {isFinal && <div style={{fontSize:11,color:"rgba(255,220,0,0.9)",fontWeight:700,marginTop:3}}>👑 さいしゅうしんか！</div>}

      {/* 進化ボタン＋進化先ヒント (テスト中は分岐ステージでも必ず表示) */}
      {(canEvolve || (mon.testEvolve && !isFinal)) && !evolving && (()=>{
        const nextId = computeNextStageId();
        const nextDef = nextId ? MONSTER_TREE[nextId] : null;
        return(
          <>
            <button onClick={doEvolve} style={{display:"block",margin:"8px auto 0",background:"linear-gradient(135deg,#fde68a,#f59e0b)",border:"none",borderRadius:999,padding:"6px 16px",color:"#7c2d12",fontWeight:900,fontSize:11,cursor:"pointer",fontFamily:F,animation:"evoPulse 1.2s ease-in-out infinite",boxShadow:"0 0 14px rgba(251,191,36,0.8)"}}>
              {isEgg?"🐣 うまれるよ！":"🌟 しんかできるよ！"}
            </button>
            {nextDef&&<div style={{fontSize:11,color:"rgba(253,230,138,0.8)",marginTop:3}}>→ {nextDef.name}{isEgg?"が うまれそう！":"になりそう！"}</div>}
          </>
        );
      })()}
      {/* 卒業(猫) / 転生(その他) ボタン＋説明 */}
      {canReincarnate && !evolving && (
        monDef.line==="cat" ? (
          <>
            <button onClick={doGraduate} style={{display:"block",margin:"6px auto 0",background:"linear-gradient(135deg,#34c77b,#187a4e)",border:"none",borderRadius:999,padding:"5px 14px",color:"#fff",fontWeight:900,fontSize:11,cursor:"pointer",fontFamily:F,boxShadow:"0 0 10px rgba(52,199,123,0.7)"}}>
              🎓 卒業して次の子をむかえる
            </button>
            <div style={{fontSize:11,color:"rgba(180,255,210,0.85)",marginTop:2,lineHeight:1.4}}>育て切った！うちのこに加わって、新しい猫のタマゴが届くよ🐈</div>
          </>
        ) : (
          <>
            <button onClick={doReincarnate} style={{display:"block",margin:"6px auto 0",background:"linear-gradient(135deg,#818cf8,#6366f1)",border:"none",borderRadius:999,padding:"5px 14px",color:"#fff",fontWeight:900,fontSize:11,cursor:"pointer",fontFamily:F,boxShadow:"0 0 10px rgba(99,102,241,0.7)"}}>
              🔄 転生する
            </button>
            <div style={{fontSize:11,color:"rgba(200,180,255,0.8)",marginTop:2,lineHeight:1.4}}>卵に戻って7日間ポイント+5%！</div>
          </>
        )
      )}
      {/* 転生までのヒント（最終形でまだ条件未達のとき） */}
      {isFinal && !canReincarnate && !evolving && (
        <div style={{marginTop:6,fontSize:11,color:"rgba(255,255,255,0.6)",fontWeight:700}}>
          🔄 転生まで {fmtTimeRemain(mon.reincRemainMs)||"もう少し…"}
        </div>
      )}
      {evolving && (
        <div style={{marginTop:8,fontSize:11,fontWeight:800,color:"#fde68a",animation:"evoFlash 0.35s ease-in-out infinite"}}>しんかちゅう…✨</div>
      )}
      {/* タマゴからやり直す(別の進化を試せる) */}
      {evolved && !evolving && update && (
        <button onClick={()=>{ if(typeof window!=="undefined" && window.confirm("タマゴからやり直す？\nずかんはそのまま。ちがう進化を試せるよ！")) doRehatch(); }}
          style={{display:"block",margin:"7px auto 0",background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.22)",borderRadius:999,padding:"4px 12px",color:"rgba(255,255,255,0.78)",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F}}>
          🥚 タマゴからやり直す
        </button>
      )}

      <style>{`
        @keyframes smPop{0%{opacity:0;transform:translateX(-50%) scale(0.7)}70%{transform:translateX(-50%) scale(1.06)}100%{opacity:1;transform:translateX(-50%) scale(1)}}
        @keyframes smSparkle{0%{opacity:1;transform:translate(0,0)}100%{opacity:0;transform:translate(0,-28px)}}
        @keyframes monFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
        @keyframes monBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
        @keyframes monShadow{0%,100%{transform:scaleX(1);opacity:.15}50%{transform:scaleX(.55);opacity:.07}}
        @keyframes neglFly{0%,100%{transform:translate(0,0) rotate(-8deg)}50%{transform:translate(-6px,-5px) rotate(8deg)}}
        @keyframes neglStink{0%{transform:translateY(2px) scale(.85);opacity:0}40%{opacity:.8}100%{transform:translateY(-14px) scale(1.1);opacity:0}}
        @keyframes evoPulse{0%,100%{box-shadow:0 0 14px rgba(251,191,36,0.8);transform:scale(1)}50%{box-shadow:0 0 26px rgba(251,191,36,1);transform:scale(1.07)}}
        @keyframes evoFlash{0%,100%{opacity:1}50%{opacity:0.3}}
      `}</style>
    </div>
  );
}

// ── Monster Zukan ──────────────────────────────────────
function MonsterZukan({ data, child }) {
  const [expandId, setExpandId] = useState(null);
  const discovered = data.monsterDiscovered?.[child.id] || [];
  const allIds = ["egg","m01","m02","m03","m04","m05","m06","m07","m08","m09","m10","m11","m12","m13","m14"];
  const foundCount = allIds.filter(id => discovered.includes(id) || id==="egg").length;

  // 分岐チャート構成: 共通の道 → 分岐点 → 3系統の枝
  const COMMON = ["egg","m01","m02"];
  const BRANCHES = [
    { line:"a", label:"森のみち",     emoji:"🌱", color:G,    bg:GS,
      cond:"まいにちつづけて さいこう7日れんぞく", ids:["m03","m04","m05","m06"] },
    { line:"b", label:"たからのみち", emoji:"💰", color:GOLD, bg:GOLDS,
      cond:"ちょきんを 1000までためる",             ids:["m07","m08","m09","m10"] },
    { line:"c", label:"まなびのみち", emoji:"📖", color:P,    bg:PS,
      cond:"もくひょうを 1つたっせいする",           ids:["m11","m12","m13","m14"] },
  ];

  const Card = ({id, accent}) => {
    const def = MONSTER_TREE[id];
    const found = discovered.includes(id) || id === "egg";
    const isOpen = expandId === id;
    return (
      <div onClick={()=>found ? setExpandId(isOpen?null:id) : null}
        style={{flex:1,minWidth:0,background:found?CARD:CARDS,border:isOpen?`2px solid ${accent||G}`:`1.5px solid ${BORDER}`,borderRadius:12,padding:"6px 2px",textAlign:"center",cursor:found?"pointer":"default"}}>
        <img src={`/assets/monster_${id}_f0.png`} alt={found?def.name:"???"}
          style={{width:42,height:42,objectFit:"contain",display:"block",margin:"0 auto 2px",imageRendering:"pixelated",filter:found?"none":"brightness(0)"}}
          onError={e=>{e.target.style.visibility="hidden"}}/>
        <div style={{fontSize:11,fontWeight:800,color:found?TEXT:MUTED,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          {found ? def.name : "???"}
        </div>
        <div style={{fontSize:11,color:GOLD,fontWeight:700}}>{"★".repeat(def.rarity)}</div>
      </div>
    );
  };
  const Arrow = ({color}) => (
    <div style={{display:"flex",alignItems:"center",fontSize:11,color:color||MUTED,fontWeight:900,flexShrink:0,padding:"0 1px"}}>▶</div>
  );
  // タップしたモンスターの詳細(その行の下に全幅表示)
  const Detail = ({ids}) => {
    if (!expandId || !ids.includes(expandId)) return null;
    const def = MONSTER_TREE[expandId];
    if (!(discovered.includes(expandId) || expandId==="egg")) return null;
    return (
      <div style={{marginTop:6,background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"8px 10px",fontSize:11,color:TEXTS,lineHeight:1.6,textAlign:"left"}}>
        <div style={{fontWeight:800,color:TEXT,marginBottom:2}}>{def.name} <span style={{color:GOLD}}>{"★".repeat(def.rarity)}</span></div>
        <div style={{marginBottom:3}}>{def.desc}</div>
        {def.branchHint && <div style={{color:GP,fontWeight:700,marginBottom:3}}>🔀 {def.branchHint}</div>}
        {def.edu && <div style={{color:B,fontSize:11}}>{def.edu}</div>}
      </div>
    );
  };

  return (
    <div style={{padding:"0 0 8px"}}>
      <div style={{fontSize:11,color:MUTED,fontWeight:700,marginBottom:10}}>
        発見済み {foundCount} / {allIds.length}
      </div>

      {/* ── 共通の道 ── */}
      <div style={{fontSize:11,color:MUTED,fontWeight:800,marginBottom:4}}>はじまりの道（みんな共通）</div>
      <div style={{display:"flex",gap:2,alignItems:"stretch"}}>
        <Card id="egg"/><Arrow/><Card id="m01"/><Arrow/><Card id="m02"/>
        <div style={{flex:1.2}}/>
      </div>
      <Detail ids={COMMON}/>

      {/* ── 分岐点 ── */}
      <div style={{display:"flex",alignItems:"center",gap:8,margin:"10px 0 8px"}}>
        <div style={{flex:1,height:1.5,background:BORDER}}/>
        <div style={{fontSize:11,fontWeight:900,color:GP}}>🔀 コロミントから 3つの道に分岐！</div>
        <div style={{flex:1,height:1.5,background:BORDER}}/>
      </div>

      {/* ── 3系統の枝 ── */}
      {BRANCHES.map(br => (
        <div key={br.line} style={{marginBottom:10,background:br.bg,border:`1.5px solid ${br.color}40`,borderRadius:14,padding:"8px 8px 8px"}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
            <span style={{fontSize:12}}>{br.emoji}</span>
            <span style={{fontSize:11,fontWeight:900,color:TEXT}}>{br.label}</span>
            <span style={{fontSize:11,color:GOLD,fontWeight:700}}>…★{MONSTER_TREE[br.ids[3]].rarity}まで</span>
          </div>
          <div style={{fontSize:11,color:TEXTS,fontWeight:700,marginBottom:6}}>条件: {br.cond} で進化</div>
          <div style={{display:"flex",gap:2,alignItems:"stretch"}}>
            {br.ids.map((id,i)=>(
              <React.Fragment key={id}>
                {i>0 && <Arrow color={br.color}/>}
                <Card id={id} accent={br.color}/>
              </React.Fragment>
            ))}
          </div>
          <Detail ids={br.ids}/>
        </div>
      ))}

      {/* ── 👑 ヤミノオウの道(特別・ボス撃破の卵から育てる7段階。通常タネモンと同じく進化で図鑑登録) ── */}
      {(()=>{
        const disc = data.monsterDiscovered?.[child.id]||[];
        const sid = (s)=> s.sprite==="yamiegg"?"yami_egg":s.sprite==="yami"?"yami_u":s.sprite;
        const reached = (s)=> disc.includes(sid(s));
        const reachedCount = DARK_EGG_STAGES.filter(reached).length;
        const hasEgg = !!data.yamiEgg?.[child.id] || reachedCount>0;
        return (
          <div style={{marginTop:6,background:"linear-gradient(135deg,#2a1f4a,#3d2b66)",border:"1.5px solid #7b61c9",borderRadius:14,padding:"10px 8px",color:"#fff"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
              <span style={{fontSize:12}}>👑</span>
              <span style={{fontSize:11,fontWeight:900}}>ヤミノオウの道（特別）</span>
              <span style={{fontSize:10,color:"rgba(255,255,255,0.6)",marginLeft:"auto"}}>{reachedCount}/{DARK_EGG_STAGES.length}</span>
            </div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.55)",marginBottom:8,lineHeight:1.5}}>{hasEgg?"そだてる で タネモンとして 育てよう！お手伝い・なでなで・時間で 進化":"バトルで ヤミノオウを 倒すと タマゴが手に入る"}</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:5}}>
              {DARK_EGG_STAGES.map(s=>{
                const ok=reached(s);
                return (
                  <div key={s.sprite} style={{textAlign:"center",background:ok?"rgba(255,255,255,0.08)":"rgba(0,0,0,0.2)",borderRadius:10,padding:"6px 2px"}}>
                    <div style={{position:"relative",width:34,height:34,margin:"0 auto 2px",filter:ok?"none":"grayscale(1) brightness(.4)"}}>
                      <img src={`/assets/gacha_gs_${s.sprite}_a.png`} alt="" style={{width:"100%",height:"100%",objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{e.target.style.display="none";const sp=e.target.nextSibling;if(sp)sp.style.display="block";}}/>
                      <span style={{display:"none",fontSize:24}}>{s.emoji}</span>
                    </div>
                    <div style={{fontSize:9.5,fontWeight:800,color:ok?"#fff":"rgba(255,255,255,0.4)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ok?s.name:"???"}</div>
                    <div style={{fontSize:8.5,color:"rgba(255,255,255,0.45)"}}>{s.stage}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── 👾 てきの図鑑(なまけの闇の手下・倒すと解放＝お金の学び) ── */}
      {(()=>{
        const dex = data.enemyDex?.[child.id] || [];
        const enemies = [...WILD_MONSTERS, BOSS_MONSTER];
        const got = enemies.filter(e=>dex.includes(e.img)).length;
        return (
          <div style={{marginTop:6,background:CARDS,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"10px 8px"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
              <span style={{fontSize:12}}>👾</span>
              <span style={{fontSize:11,fontWeight:900,color:TEXT}}>てきの図鑑（なまけの闇）</span>
              <span style={{fontSize:10,color:MUTED,marginLeft:"auto"}}>{got}/{enemies.length}</span>
            </div>
            <div style={{fontSize:10,color:MUTED,marginBottom:8,lineHeight:1.5}}>倒すと 物語と「お金の学び」が 解放されるよ。</div>
            {enemies.map(e=>{
              const ok=dex.includes(e.img);
              return (
                <div key={e.img} style={{display:"flex",alignItems:"flex-start",gap:9,padding:"7px 4px",borderTop:`1px solid ${BORDER}`}}>
                  <div style={{width:36,height:36,flexShrink:0,filter:ok?"none":"brightness(0)",opacity:ok?1:0.5}}>
                    <img src={`/assets/${e.img}.png`} alt="" style={{width:"100%",height:"100%",objectFit:"contain",imageRendering:"pixelated"}} onError={ev=>{ev.target.style.display="none";const sp=ev.target.nextSibling;if(sp)sp.style.display="block";}}/>
                    <span style={{display:"none",fontSize:26}}>{ok?e.emoji:"❓"}</span>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:800,color:ok?TEXT:MUTED}}>{ok?`${e.name}（${e.title}）`:"？？？"}<span style={{fontSize:10,color:GOLD,fontWeight:700,marginLeft:4}}>Lv.{e.lv}</span></div>
                    {ok
                      ? <div style={{fontSize:10.5,color:B,marginTop:2,lineHeight:1.5}}>💡 {e.lesson}</div>
                      : <div style={{fontSize:10.5,color:MUTED,marginTop:2}}>🔒 倒すと わかる</div>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
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
              <div style={{lineHeight:1}}><Emo e={child.emoji} size={30}/></div>
              <div style={{fontSize:11,fontWeight:700,color:TEXT,marginTop:4}}>{child.name}</div>
              <div style={{fontSize:11,color:R,fontWeight:700}}>-{amt.toLocaleString()}pt</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:26,color:GP}}>→</div>
              <div style={{fontSize:11,color:GP,fontWeight:800}}>{amt.toLocaleString()}pt</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:30,lineHeight:1}}>{receiver?.emoji}</div>
              <div style={{fontSize:11,fontWeight:700,color:TEXT,marginTop:4}}>{receiver?.name}</div>
              <div style={{fontSize:11,color:GP,fontWeight:700}}>+{amt.toLocaleString()}pt</div>
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
                  <Emo e={m.emoji} size={20}/>
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
// ── 家族バトル・シーズン(戦闘力ランキング/ハンデ・週次シーズン/お金行動で強くなる可視化/投資で強化) ──
function FamilyBattleSeason({child, data, update, onClose}){
  const members=[...(data.children||[]),...(data.parents||[])].filter(Boolean);
  const week=Math.floor(Date.now()/(7*86400000));
  const bs=data.battleSeason;
  useEffect(()=>{
    if(!bs || bs.week!==week){
      let champ=null;
      if(bs && bs.base){
        let best=null;
        members.forEach(m=>{ const g=Math.max(0,battlePower(data,m)-(bs.base[m.id]??battlePower(data,m))); if(!best||g>best.score) best={name:m.name,score:g}; });
        if(best && best.score>0) champ=best;
      }
      const base={}; members.forEach(m=>{ base[m.id]=battlePower(data,m); });
      update(d=>({...d, battleSeason:{week, base, champ}}));
    }
  // eslint-disable-next-line
  },[week]);
  const base=(bs&&bs.week===week)?(bs.base||{}):{};
  const champ=(bs&&bs.week===week)?bs.champ:null;
  const [tab,setTab]=useState("growth");  // growth=今シーズンの成長 / power=そうごう戦闘力
  const rows=members.map(m=>{ const bp=battlePower(data,m); return {m,bp,growth:Math.max(0,bp-(base[m.id]??bp)),adj:Math.round(bp*bpHandicap(m))}; })
    .sort((a,b)=> tab==="growth" ? b.growth-a.growth : b.adj-a.adj);
  const ms=battleStats(data,child); const myBP=battlePower(data,child);
  const eqNames=(ms.equip||[]).map(e=>`${e.e}${e.name}`).join(" ")||"そうび なし";
  const myBal=bal(data.logs, child.id);
  const balGear=EQUIPMENT.filter(it=>it.need.k==="bal").sort((a,b)=>a.need.v-b.need.v);
  const seasonStart=new Date(week*7*86400000), seasonEnd=new Date((week*7+6)*86400000);
  const md=d=>`${d.getMonth()+1}/${d.getDate()}`;
  const medal=i=>["🥇","🥈","🥉"][i]||`${i+1}位`;
  return (
    <div style={{position:"fixed",inset:0,background:"#0009",zIndex:992,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:BG,borderRadius:"24px 24px 0 0",padding:"20px 16px 36px",width:"100%",maxWidth:440,maxHeight:"92vh",overflowY:"auto",boxShadow:"0 -8px 40px #0004"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:900,fontSize:18,color:TEXT}}>🏆 家族バトル・シーズン</div>
            <div style={{color:MUTED,fontSize:12,marginTop:1}}>今シーズン {md(seasonStart)}〜{md(seasonEnd)}・毎週リセット</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>✕</button>
        </div>
        {champ && <div style={{background:`linear-gradient(135deg,${GOLDS},#fff)`,border:`1.5px solid ${GOLD}`,borderRadius:12,padding:"8px 12px",marginBottom:10,fontSize:12.5,fontWeight:800,color:"#7a5a00"}}>👑 前シーズンの王者：{champ.name}（戦闘力 +{champ.score} 成長）</div>}
        {/* タブ切り替え */}
        <div style={{display:"flex",gap:6,marginBottom:12,background:CARDS,borderRadius:12,padding:4}}>
          {[["growth","今シーズンの成長"],["power","そうごう戦闘力"]].map(([k,l])=>(
            <button key={k} onClick={()=>setTab(k)} style={{flex:1,background:tab===k?"#fff":"transparent",border:tab===k?`1.5px solid ${GP}`:"1.5px solid transparent",borderRadius:9,padding:"7px",fontWeight:800,fontSize:12,color:tab===k?GP:MUTED,cursor:"pointer",fontFamily:F}}>{l}</button>
          ))}
        </div>
        <div style={{fontSize:11,color:MUTED,marginBottom:8,lineHeight:1.5}}>{tab==="growth"?"今週どれだけ強くなったか＝お金の行動や育成で伸びる。年れいに関係なく公平！":"いまの戦闘力にハンデ補正（年下ほど有利・親はひかえめ）をかけた総合順位。"}</div>
        {/* ランキング */}
        <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:16}}>
          {rows.map((r,i)=>{
            const me=r.m.id===child.id;
            return (
              <div key={r.m.id} style={{display:"flex",alignItems:"center",gap:10,background:me?GS:CARD,border:me?`2px solid ${GP}`:`1.5px solid ${BORDER}`,borderRadius:12,padding:"9px 12px"}}>
                <span style={{fontSize:16,width:30,textAlign:"center",fontWeight:900,color:i<3?GOLD:MUTED}}>{medal(i)}</span>
                <ChildAvatar child={r.m} size={32}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:800,fontSize:13,color:TEXT,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.m.name}{me?"（あなた）":""}</div>
                  <div style={{fontSize:10.5,color:MUTED}}>戦闘力 {r.bp}{tab==="power"?` → 補正後 ${r.adj}`:""}</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontWeight:900,fontSize:16,color:tab==="growth"?(r.growth>0?G:MUTED):GP}}>{tab==="growth"?`+${r.growth}`:r.adj}</div>
                  <div style={{fontSize:9,color:MUTED}}>{tab==="growth"?"成長":"そうごう"}</div>
                </div>
              </div>
            );
          })}
        </div>
        {/* お金行動で強くなる：自分の強さの内訳 */}
        <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"13px 14px",marginBottom:12}}>
          <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:8}}>💪 あなたの強さの内訳（戦闘力 {myBP}・⚡{ms.spd}）</div>
          {[
            ["📊","レベル",`Lv.${ms.lv}（${monRank(ms.lv)}）`,"クイズ正解・お手伝いで EXP→レベルUP。Lvでステ＆称号UP・カプセル報酬"],
            ["⚔","そうび",eqNames,"武器をドロップして『そうび』すると強くなる"],
            ["⚡","すばやさ",`${ms.spd}`,"素早い方が バトルで先に こうげきできる"],
            ["🌱","育成",`${(getMonState(data,child).careDays||0)}日 なでなで`,"進化と なでなでで ステータスUP"],
            ...((ms.eggDrops||0)>0?[["🥚","卵ボーナス",`基礎+${ms.eggDrops}%`,"ヤミノオウを倒して タマゴを集めるほど基礎UP"]]:[]),
            ...(((data.reincPower||{})[child.id]||0)>0?[["♻","転生パワー",`基礎+${((data.reincPower||{})[child.id]||0)*0.5}%`,"転生でレベルは1に戻るが、到達Lvが永続パワーに(0.5%/Lv)"]]:[]),
          ].map(([e,l,v,hint],i)=>(
            <div key={i} style={{display:"flex",alignItems:"flex-start",gap:9,padding:"5px 0",borderTop:i?`1px solid ${BORDER}`:"none"}}>
              <span style={{fontSize:16,width:20,textAlign:"center"}}>{e}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:800,color:TEXT}}>{l}：<span style={{color:GP}}>{v}</span></div>
                <div style={{fontSize:10.5,color:MUTED,marginTop:1,lineHeight:1.4}}>{hint}</div>
              </div>
            </div>
          ))}
        </div>
        {/* 投資で強化する動線：貯金で強い装備が解放 */}
        <div style={{background:BS,border:`1.5px solid ${B}40`,borderRadius:14,padding:"13px 14px"}}>
          <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:3}}>📈 投資で もっと強く</div>
          <div style={{fontSize:11,color:TEXTS,marginBottom:9,lineHeight:1.5}}>株の配当で貯金を増やすと、強い装備が解放！（いまの貯金 {myBal.toLocaleString()}pt）</div>
          {balGear.map(it=>{
            const got=myBal>=it.need.v; const rem=it.need.v-myBal;
            return (
              <div key={it.id} style={{display:"flex",alignItems:"center",gap:9,padding:"6px 0"}}>
                <span style={{fontSize:18,filter:got?"none":"grayscale(1) opacity(.5)"}}>{it.e}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:800,color:got?TEXT:MUTED}}>{it.name} <span style={{fontSize:10,color:B}}>{[it.atk?`⚔+${it.atk}`:"",it.def?`🛡+${it.def}`:"",it.hp?`HP+${it.hp}`:""].filter(Boolean).join(" ")}</span></div>
                  <div style={{height:5,borderRadius:999,background:"#0001",overflow:"hidden",marginTop:3}}>
                    <div style={{height:"100%",width:`${Math.min(100,Math.round(myBal/it.need.v*100))}%`,background:got?G:B,borderRadius:999}}/>
                  </div>
                </div>
                <span style={{fontSize:10.5,fontWeight:800,color:got?G:MUTED,flexShrink:0,width:64,textAlign:"right"}}>{got?"解放ずみ":`あと${rem.toLocaleString()}`}</span>
              </div>
            );
          })}
        </div>
        <button onClick={onClose} style={{width:"100%",marginTop:16,background:GP,border:"none",borderRadius:14,padding:"13px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>とじる</button>
      </div>
    </div>
  );
}

function WeeklyReport({child,data,onClose}){
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-7);
  const logs=(data.logs||[]).filter(l=>l.cid===child.id&&l.date>=cutoff.toISOString());
  const earned=logs.filter(l=>["good","daily","gacha","interest"].includes(l.type)).reduce((s,l)=>s+l.pts,0);
  const deducted=Math.abs(logs.filter(l=>["bad","violation"].includes(l.type)).reduce((s,l)=>s+l.pts,0));
  const taskCount=logs.filter(l=>l.type==="good").length;
  const gachaCount=logs.filter(l=>l.type==="gacha").length;
  const curBal=bal(data.logs,child.id);
  const interest=data.interestEnabled?Math.floor(curBal*(data.interestRate||0.05)):0;
  // ── C: お金の学び 計測指標 ──
  const validQuiz=new Set(ALL_TIPS.map(t=>t.id));
  const quizMastered=((data.tipsQuiz||{})[child.id]||[]).filter(id=>validQuiz.has(id)).length;  // クイズ正解(累計マスター)
  const tipsWeek=logs.filter(l=>l.type==="tips").length;                                          // 今週読んだまめちしき
  const investWeek=logs.filter(l=>["invest_buy","invest_sell","forex_buy","forex_sell"].includes(l.type)).length; // 投資チャレンジ
  const goalsDone=(data.goals||[]).filter(g=>g.cid===child.id&&g.done).length;                    // 目標達成(累計)
  const streakCur=(data.streak||{})[child.id]?.cur||0;
  const netWeek=earned-deducted;
  // おかねの学びスコア(0-100): 学び30+継続20+お手伝い20+お金の行動20+収支プラス10。週ごとの伸びを親が追える単一指標
  const sLearn=Math.round(quizMastered/ALL_TIPS.length*30);
  const sStreak=Math.round(Math.min(streakCur,7)/7*20);
  const sTask=Math.round(Math.min(taskCount,10)/10*20);
  const sMoney=Math.min(20, goalsDone*8 + Math.min(investWeek,4)*3);
  const sNet=netWeek>=0?10:0;
  const learnScore=Math.min(100, sLearn+sStreak+sTask+sMoney+sNet);
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
              <div style={{color:MUTED,fontSize:11,fontWeight:700,marginBottom:2}}>{l}</div>
              {p!==null?<div style={{fontWeight:900,fontSize:14,color:c}}>{p>=0?"+":""}{p}pt</div>:<div style={{fontWeight:900,fontSize:14,color:c}}>{v}</div>}
            </div>
          ))}
        </div>
        {/* ── C: お金の学び 計測サマリ ── */}
        <div style={{background:PS,border:`1.5px solid ${P}40`,borderRadius:14,padding:"13px 14px",marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <span style={{fontWeight:800,fontSize:13,color:TEXT}}>🧠 おかねの学び</span>
            <span style={{fontWeight:900,fontSize:18,color:P}}>{learnScore}<span style={{fontSize:11,color:MUTED,fontWeight:700}}>/100</span></span>
          </div>
          <div style={{height:9,borderRadius:999,background:"#0001",overflow:"hidden",marginBottom:4}}>
            <div style={{height:"100%",width:`${learnScore}%`,background:`linear-gradient(90deg,${P},${G})`,borderRadius:999,transition:"width .5s"}}/>
          </div>
          <div style={{fontSize:11,color:MUTED,marginBottom:10}}>学び{sLearn}＋継続{sStreak}＋お手伝い{sTask}＋お金の行動{sMoney}＋収支{sNet}。毎週どう伸びたか比べてみてください</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[
              ["💡","まめちしきクイズ正解",`${quizMastered}/${ALL_TIPS.length}`,"累計マスター"],
              ["📖","今週 読んだ知識",`${tipsWeek}`,"件"],
              ["📈","投資チャレンジ",`${investWeek}`,"今週の回数"],
              ["🎯","目標 達成",`${goalsDone}`,"累計"],
            ].map(([e,l,v,sub],i)=>(
              <div key={i} style={{background:CARD,borderRadius:10,padding:"9px 11px",display:"flex",alignItems:"center",gap:9}}>
                <span style={{fontSize:18}}>{e}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,color:MUTED,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{l}</div>
                  <div style={{fontWeight:900,fontSize:14,color:TEXT}}>{v}<span style={{fontSize:10,color:MUTED,fontWeight:600,marginLeft:3}}>{sub}</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{background:`${G}15`,border:`1.5px solid ${G}40`,borderRadius:14,padding:"12px 14px",marginBottom:16}}>
          <p style={{margin:0,fontSize:13,fontWeight:700,lineHeight:1.7,color:TEXT}}>
            {learnScore>=70?"🌟 お金の学びがぐんぐん伸びています！この調子で続けましょう。":quizMastered<5?"💡 まめちしきクイズに挑戦すると『お金の知識』が伸びます。お子さんに勧めてみて。":taskCount>=5?"🌟 すごい！今週はお手伝いをたくさんしたね！":taskCount>=3?"👍 いい調子！来週もがんばろう！":"💪 来週はもっとお手伝いに挑戦してみよう！"}
          </p>
        </div>
        <button onClick={onClose} style={{width:"100%",background:G,border:"none",borderRadius:14,padding:"13px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>とじる</button>
      </div>
    </div>
  );
}

// ── シェアカード生成（達成の瞬間をSNSへ。canvasで画像化→navigator.share）──
async function shareCard({ emoji, title, subtitle, color, img, rarity }){
  try{
    const W=1080,H=1080; const accent=color||GP;
    const cv=document.createElement("canvas"); cv.width=W; cv.height=H;
    const x=cv.getContext("2d");
    const rr=(X,Y,w,h,r)=>{x.beginPath();x.moveTo(X+r,Y);x.arcTo(X+w,Y,X+w,Y+h,r);x.arcTo(X+w,Y+h,X,Y+h,r);x.arcTo(X,Y+h,X,Y,r);x.arcTo(X,Y,X+w,Y,r);x.closePath();};
    // 画像があれば先読み(同一オリジン)
    let im=null;
    if(img){ im=await new Promise(res=>{const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=img;}); }
    // 背景グラデ＋アクセント光彩
    const g=x.createLinearGradient(0,0,0,H); g.addColorStop(0,"#F7F5EF"); g.addColorStop(1,"#E3F3E8"); x.fillStyle=g; x.fillRect(0,0,W,H);
    const rg=x.createRadialGradient(W/2,500,40,W/2,500,460); rg.addColorStop(0,accent+"40"); rg.addColorStop(1,accent+"00"); x.fillStyle=rg; x.fillRect(0,0,W,H);
    x.fillStyle=accent; x.fillRect(0,0,W,20);
    x.textAlign="center"; x.textBaseline="middle";
    // ヘッダー
    x.fillStyle=accent; x.font="700 50px sans-serif"; x.fillText("🌱 Tane Money", W/2, 112);
    // レア度バッジ
    if(rarity){ x.font="800 46px sans-serif"; const tw=x.measureText(rarity).width; const pw=tw+76, ph=80, py=158; rr(W/2-pw/2,py,pw,ph,40); x.fillStyle=accent; x.fill(); x.fillStyle="#fff"; x.fillText(rarity, W/2, py+ph/2+2); }
    // メダリオン
    const cy=510, cr=280;
    x.save(); x.shadowColor=accent+"77"; x.shadowBlur=70; x.beginPath(); x.arc(W/2,cy,cr,0,Math.PI*2); x.fillStyle="#ffffff"; x.fill(); x.restore();
    x.lineWidth=16; x.strokeStyle=accent; x.beginPath(); x.arc(W/2,cy,cr,0,Math.PI*2); x.stroke();
    // アイテム(画像優先・なければ絵文字)
    if(im){ const s=390, ratio=Math.min(s/im.width,s/im.height), dw=im.width*ratio, dh=im.height*ratio; x.imageSmoothingEnabled=false; x.drawImage(im, W/2-dw/2, cy-dh/2, dw, dh); }
    else { x.font="300px sans-serif"; x.fillText(emoji||"🌟", W/2, cy+8); }
    // キラキラ
    x.font="62px sans-serif"; x.fillText("✨", W/2-cr-6, cy-cr+70); x.fillText("⭐", W/2+cr+8, cy-cr+120); x.fillText("✨", W/2+cr-6, cy+cr-6);
    // タイトル
    x.fillStyle="#18231D"; x.font="bold 80px sans-serif"; x.fillText((title||"").toString().slice(0,20), W/2, 868);
    // サブ
    x.fillStyle=accent; x.font="bold 62px sans-serif"; x.fillText((subtitle||"").toString().slice(0,26), W/2, 956);
    // フッター
    x.fillStyle="#929B95"; x.font="600 40px sans-serif"; x.fillText("おてつだいで お金を学ぶ · tane-money.vercel.app", W/2, 1018);
    const blob=await new Promise(r=>cv.toBlob(r,"image/png"));
    const file=new File([blob],"tane-money.png",{type:"image/png"});
    const payload={ title:"Tane Money", text:`${title||""} ${subtitle||""}`.trim()+" #タネマネー", url:"https://tane-money.vercel.app" };
    if(navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({ ...payload, files:[file] });
    } else if(navigator.share){
      await navigator.share(payload);
    } else {
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="tane-money.png"; a.click();
    }
  }catch(e){ /* キャンセル/非対応は無視 */ }
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
          <div style={{display:"flex",gap:10,justifyContent:"center"}}>
            <button onClick={()=>shareCard({emoji:goal.emoji, title:`${goal.label} 達成！`, subtitle:`${goal.target.toLocaleString()}pt ためたよ`, color:Y})}
              style={{background:"#fff",border:`2px solid ${Y}`,borderRadius:14,padding:"14px 22px",color:"#9a7000",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>シェア 📤</button>
            <button onClick={onClose} style={{background:Y,border:"none",borderRadius:14,padding:"14px 32px",color:TEXT,fontWeight:900,fontSize:16,cursor:"pointer",fontFamily:F}}>やったー！🎉</button>
          </div>
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
  const [fxFlash, setFxFlash] = useState(null);   // 売買トースト
  const myBal = bal(data.logs, child?.id||"");

  const FOREX_BUY_FEE  = 0.005; // 買い手数料0.5%
  const FOREX_SELL_FEE = 0.005; // 売り手数料0.5%

  // 保有外貨
  const myForex = (data.forexHoldings||{})[child?.id||""]||{};

  // 保護者設定: 1日の売買回数上限(株と為替の合算)
  const _fxLimit=(data.familySettings?.dailyTradeLimit)||0;
  const _fxTodayStr=new Date().toDateString();
  const _fxTradesToday=(data.logs||[]).filter(l=>l.cid===(child?.id||"")&&(l.type==="invest_buy"||l.type==="invest_sell"||l.type==="forex_buy"||l.type==="forex_sell")&&new Date(l.date).toDateString()===_fxTodayStr).length;
  const _fxLimitReached=_fxLimit>0&&_fxTradesToday>=_fxLimit;

  const doForexBuy = (fx) => {
    const amt = parseFloat(tradeAmt);
    if(!amt || amt <= 0 || !child) return;
    if(_fxLimitReached){ alert("きょうの 売り買いは ここまで！また あした🌙"); return; }
    const rate = fx.price||0;
    const costPts = Math.ceil(amt * rate * (1 + FOREX_BUY_FEE));
    if(myBal < costPts) { alert("残高が足りないよ！"); return; }
    if(!txGuard("fxbuy_"+child.id)) return;   // 連打ガード(二重購入防止)
    const entry = {id:uid(),cid:child.id,type:"forex_buy",
      label:`💱 ${fx.flag}${fx.code} ${amt}購入（¥${rate}・手数料${(FOREX_BUY_FEE*100).toFixed(1)}%込）`,
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
    setFxFlash({msg:`💱 ${fx.flag}${fx.code} ${amt} こうにゅう！`,color:"#22c55e"});
    setTimeout(()=>setFxFlash(null),1700);
    setTradeAmt("");
  };

  const doForexSell = (fx) => {
    const amt = parseFloat(tradeAmt);
    const held = myForex[fx.code]||0;
    if(!amt || amt <= 0 || amt > held || !child) return;
    if(_fxLimitReached){ alert("きょうの 売り買いは ここまで！また あした🌙"); return; }
    if(!txGuard("fxsell_"+child.id)) return;   // 連打ガード(二重売却防止)
    const rate = fx.price||0;
    const earnPts = Math.floor(amt * rate * (1 - FOREX_SELL_FEE));
    const entry = {id:uid(),cid:child.id,type:"forex_sell",
      label:`💱 ${fx.flag}${fx.code} ${amt}売却（手数料0.5%引後）`,
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
    setFxFlash({msg:`💱 ${fx.flag}${fx.code} ${amt} 売却 +${earnPts.toLocaleString()}pt`,color:"#E8B83E"});
    setTimeout(()=>setFxFlash(null),1700);
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
      {fxFlash&&(
        <div style={{position:"fixed",top:0,left:0,right:0,zIndex:1400,display:"flex",justifyContent:"center",pointerEvents:"none"}}>
          <div style={{marginTop:14,background:fxFlash.color,color:"#fff",fontWeight:900,fontSize:14,padding:"11px 20px",borderRadius:14,boxShadow:"0 8px 24px rgba(0,0,0,.35)"}}>{fxFlash.msg}</div>
        </div>
      )}
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
        <div style={{fontSize:11,color:"#444",marginTop:4}}>※ 100円 = 1pt換算・手数料除く</div>
      </div>

      {/* レートヘッダー */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:0,flex:1}}>💱 為替レート（対円）</p>
        <span style={{fontSize:11,color:pairs[0]?.realData?"#4ade80":"#f87171",fontWeight:700}}>
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
                      <div style={{fontSize:11,color:"#f5c842",fontWeight:700}}>保有:{held}{fx.code}</div>
                      <div style={{fontSize:11,color:"#4ade80",fontWeight:700}}>≈¥{Math.round(held*(fx.price||0)).toLocaleString()} / {Math.round(held*(fx.price||0)/100)}pt</div>
                    </>
                  ):(
                    <div style={{fontSize:11,color:"#555",fontWeight:700}}>未保有</div>
                  )}
                </div>
              </div>
            </button>

            {/* グラフ（常時表示） */}
            {fx.history&&fx.history.length>1&&(
              <div style={{marginTop:8}}>
                <StockChart history={fx.history} color={isUp?"#4ade80":"#f87171"} height={45} width={300}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#888",marginTop:2}}>
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
                        <span>手数料(0.5%)</span><span>+{(buyCost-Math.round(tradeAmtNum*(fx.price||0))).toLocaleString()}pt</span>
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
                        <span>手数料(0.5%)</span><span>-{(Math.round(tradeAmtNum*(fx.price||0))-sellEarn).toLocaleString()}pt</span>
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


// ── ナビ・タネモン(性格の違う相棒が いろんな視点で投資を語る。損は責めない/煽らない) ──
// 作物ドット絵: stockId→アセット接頭辞(現状りんご s5 のみ)。保有日数で成長段階を出す＝「育てる」可視化
const CROP_ART = { s5:"crop_apple", s1:"crop_game", s4:"crop_potato", s3:"crop_car", s2:"crop_note" };
// ナビ立ち絵: ナビの絵文字→ドット絵(現状フクロ博士・ガルドのみ。他は絵文字のまま)
const NAVI_ART = { "🦉":"navi_fukuro", "🐉":"navi_garu", "⚡":"navi_chale", "🌧":"navi_amefuri" };
// 🏡 模様替えデコ(あつ森型・自己表現)。lv=はたけレベルで解放。現状は絵文字プレースホルダ
const DECO_ITEMS = [
  {id:"fence",e:"🪵",n:"フェンス",lv:1},{id:"sign",e:"🪧",n:"かんばん",lv:1},{id:"tulip",e:"🌷",n:"チューリップ",lv:1},
  {id:"sun",e:"🌻",n:"ひまわり",lv:2},{id:"tree",e:"🌳",n:"き",lv:2},{id:"bush",e:"🌿",n:"しげみ",lv:2},
  {id:"mush",e:"🍄",n:"きのこ",lv:3},{id:"well",e:"⛲",n:"いど",lv:3},{id:"bench",e:"🪑",n:"ベンチ",lv:3},
  {id:"hut",e:"🏡",n:"こや",lv:4},{id:"scarecrow",e:"🧑‍🌾",n:"かかし",lv:4},{id:"butterfly",e:"🦋",n:"ちょう",lv:5},
  {id:"tractor",e:"🚜",n:"トラクター",lv:5},{id:"pond",e:"🪷",n:"いけ",lv:6},{id:"rainbow",e:"🌈",n:"にじ",lv:7},{id:"star",e:"⭐",n:"おほしさま",lv:8},
];
function holdDaysOf(h){ return h&&h.firstBuyDate ? (Date.now()-new Date(h.firstBuyDate).getTime())/86400000 : 0; }
function cropStageDays(days){ return days>=30?3 : days>=10?2 : days>=3?1 : 0; } // 0芽→1苗→2花→3実った(収穫可)
function CropArt({stockId, stage, emoji, size}){
  const pre=CROP_ART[stockId];
  if(!pre) return <span style={{fontSize:size}}>{emoji}</span>;
  const file = stage==="seed" ? `${pre}_seed` : `${pre}_${stage}`;
  return <img src={`/assets/${file}.png`} alt="" style={{width:size,height:size,objectFit:"contain",imageRendering:"pixelated",verticalAlign:"middle"}}
    onError={e=>{const s=document.createElement("span");s.textContent=emoji;s.style.fontSize=Math.round(size*0.82)+"px";e.target.replaceWith(s);}}/>;
}
const INVEST_NAVI = {
  kotsu:{e:"🌲",n:"コツメ",c:"#34C77B"},
  garu:{e:"🐉",n:"ガルド",c:"#3478D4"},
  fukuro:{e:"🦉",n:"フクロ博士",c:"#7B61C9"},
  chale:{e:"⚡",n:"チャレ",c:"#E8B83E"},
  ame:{e:"🌧",n:"アメフリ",c:"#929B95"},
};
function pickInvestNavi(gp, holdDays, concentrated, has, rot){
  const pick=(arr)=>arr[rot%arr.length];
  if(!has) return {...INVEST_NAVI.chale, line:"いこうぜ！でも“なくなってもいい分だけ”な。まずは ひとつ タネをまこう。"};
  if(gp<=-10) return {...INVEST_NAVI.ame, line:pick(["大きな雨だね。こわいよね。でも ひとりじゃないよ、いっしょに待とう。","たくさん下がったね。でも じぶんのせいじゃないよ。みんなにふる雨だから。"])};
  if(gp<-3) return {...INVEST_NAVI.ame, line:pick(["雨の日もあるよ。畑は枯れてないよ。","下がってるね。でもね、雨は かならず あがるよ。"])};
  if(gp>=20) return {...INVEST_NAVI.kotsu, line:pick(["すごいね、育ってる。でも あわてなくていいよ。","ここまで きたね。つづけてきた おかげだよ。"])};
  if(concentrated) return {...INVEST_NAVI.garu, line:"ひとつに ぜんぶ かけちゃダメ。ちらして まもろう。"};
  if(holdDays>=30) return {...INVEST_NAVI.kotsu, line:"ずっと つづけてるね。それが いちばん つよいやり方だよ。"};
  return pick([
    {...INVEST_NAVI.fukuro, line:"なんで 上がったり 下がったり するのかな？理由を 見るのが 投資だよ。"},
    {...INVEST_NAVI.garu, line:"いろんな タネを まくと、ぜんぶ いっぺんに しおれにくいよ。"},
    {...INVEST_NAVI.kotsu, line:"ゆっくりで いいよ。畑は 1日にして ならず、だよ。"},
  ]);
}
function InvestTab({child,data,update}){
  const [investTab,setInvestTab]=useState("stocks"); // stocks | forex
  const [selected,setSelected]=useState(null);
  const [mode,setMode]=useState("buy");
  const [qty,setQty]=useState("0.1");
  const [tradeComment,setTradeComment]=useState("");
  const [showChart,setShowChart]=useState(null);
  const [showShare,setShowShare]=useState(false);
  const [tradeFlash,setTradeFlash]=useState(null);   // 売買の気持ちいい完了トースト
  const [harvestBurst,setHarvestBurst]=useState(null);   // 利益確定の全画面・収穫バースト
  const [showDex,setShowDex]=useState(false);   // 収穫シール帳・作物図鑑
  const [shareCopied,setShareCopied]=useState(false);
  const [showTrade,setShowTrade]=useState(false);   // ゲームホーム ⇄ とりひき/くら（数字はここ）
  const [showDeco,setShowDeco]=useState(false);     // 🏡 模様替え
  const myBal=bal(data.logs,child.id);
  const myHoldings=(data.holdings||{})[child.id]||[];
  // 作物図鑑: 各銘柄の到達した最高成長段階(0..3)を永続記録(売っても消えない=集める楽しみ)
  const cropDex=(data.cropDex||{})[child.id]||{};
  useEffect(()=>{
    const cur={};
    myHoldings.forEach(h=>{ if(CROP_ART[h.stockId]!==undefined){ const st=cropStageDays(holdDaysOf(h)); cur[h.stockId]=Math.max(cur[h.stockId]??-1, st); }});
    const prev=(data.cropDex||{})[child.id]||{}; let changed=false; const next={...prev};
    Object.entries(cur).forEach(([k,v])=>{ if((next[k]??-1)<v){ next[k]=v; changed=true; }});
    if(changed) update(d=>({...d,cropDex:{...(d.cropDex||{}),[child.id]:next}}));
  },[]);
  // 🌱 カウシェ型「おみず／お世話で確実に育つ」エンゲージ層（射幸性なし・努力で確実）
  const farmData={water:0,care:{},xp:0,lastDraw:null,...((data.farm||{})[child.id]||{})};
  const bucketG = farmData.lastDraw ? Math.min(30, Math.max(0,(Date.now()-new Date(farmData.lastDraw).getTime())/1000*0.01)) : 30;
  const waterReserve=Math.floor(farmData.water||0);
  const farmXp=farmData.xp||0; const farmLv=Math.floor(farmXp/12)+1; const lvProg=(farmXp%12)/12;
  const flash=(msg,color)=>{ setTradeFlash({msg,color}); setTimeout(()=>setTradeFlash(null),1600); };
  const setFarm=(mut)=>update(d=>{ const f={water:0,care:{},xp:0,lastDraw:null,...((d.farm||{})[child.id]||{})}; const nf=mut({...f,care:{...(f.care||{})}}); return {...d,farm:{...(d.farm||{}),[child.id]:nf}}; });
  const drawWater=()=>{ const g=bucketG; if(g<1){flash("💧 まだ おみずが たまってないよ","#3478D4");return;} setFarm(f=>({...f,water:(f.water||0)+g,lastDraw:new Date().toISOString()})); flash(`💧 おみずを ${Math.floor(g)}g くんだ！`,"#3478D4"); };
  // 水やり＝お世話(はたけレベル＋タネモンの絆)。作物の成長/売り時には影響しない=投資は保有日数で正直に
  const waterCrop=(s,h)=>{ if((farmData.water||0)<5){flash("💧 おみずが たりない。井戸で くもう","#D95C55");return;} setFarm(f=>({...f,water:(f.water||0)-5,xp:(f.xp||0)+1})); flash("💧 おせわした！はたけレベルUPで かざりが ふえる🌱","#34C77B"); };
  const loginStreak=farmData.streak||0;
  // 📅 連続ログインボーナス(マイル型・毎日の理由。FOMOにしすぎない)
  useEffect(()=>{
    const today=new Date().toDateString();
    if(farmData.lastLogin===today) return;
    const y=new Date(Date.now()-86400000).toDateString();
    const ns=farmData.lastLogin===y?(farmData.streak||0)+1:1;
    const gain=8+Math.min(7,ns);
    setFarm(f=>({...f,water:(f.water||0)+gain,lastLogin:today,streak:ns}));
    flash(`📅 ${ns}日れんぞく ログイン！おみず +${gain}g🎁`,"#34C77B");
  },[]);
  // 🐣 なでなで(たまごっち型お世話の入口・1日10回までxp)
  const patMon=()=>{
    const today=new Date().toDateString();
    const done=farmData.patDate===today?(farmData.patN||0):0;
    if(done>=10){ flash("🌱 タネモン ごきげん！また あした なでようね","#34C77B"); return; }
    setFarm(f=>({...f,xp:(f.xp||0)+1,patDate:today,patN:(f.patDate===today?(f.patN||0):0)+1}));
    flash("🌱 なでなで♪ タネモンが よろこんでる","#34C77B");
  };
  // 🏡 模様替え: 置けるデコ数は はたけレベルで増える(📈 畑が広がる)
  const placedDeco=farmData.deco||[];
  const decoSlots=Math.min(8,2+(farmLv-1));
  const toggleDeco=(id)=>{
    const cur=(farmData.deco||[]);
    if(cur.includes(id)){ setFarm(f=>({...f,deco:(f.deco||[]).filter(x=>x!==id)})); return; }
    if(cur.length>=decoSlots){ flash(`これ以上 置けないよ。レベルアップで 増えるよ🌱（Lv.${farmLv}＝${decoSlots}コ）`,"#D95C55"); return; }
    setFarm(f=>({...f,deco:[...(f.deco||[]),id]}));
    flash("🏡 かざりを おいたよ！","#34C77B");
  };
  // 保護者設定: 為替OFF / 1日の売買回数上限
  const _fs=data.familySettings||{};
  const isJr=child.displayMode==="junior";        // 小学生は「株（畑）」だけ。為替は出さない
  const forexOff=!!_fs.forexOff || isJr;
  const tradeLimit=(_fs.dailyTradeLimit)||0;
  const _todayStr=new Date().toDateString();
  const tradesToday=(data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="invest_buy"||l.type==="invest_sell"||l.type==="forex_buy"||l.type==="forex_sell")&&new Date(l.date).toDateString()===_todayStr).length;
  const tradeLimitReached=tradeLimit>0&&tradesToday>=tradeLimit;
  const stocks=data.stocks||[];
  const fetchStatus=data.stockFetchStatus||"idle";
  const fmtPrice=s=>s.currency==="USD"?`$${s.price.toFixed(2)}`:`¥${Math.round(s.price).toLocaleString()}`;
  const toPts=(s,p)=>s.currency==="USD"?Math.max(1,Math.round(p*1.5)):Math.max(1,Math.round(p/100));
  const portfolioVal=myHoldings.reduce((s,h)=>{const st=stocks.find(x=>x.id===h.stockId);return s+(st?toPts(st,st.price)*h.qty:0);},0);
  const portfolioCost=myHoldings.reduce((s,h)=>s+h.avgPrice*h.qty,0);
  const portfolioGain=Math.round(portfolioVal*0.98)-portfolioCost; // 今売ったら戻るpt基準(手数料2%込)
  // ナビ・タネモンの語り(ポートフォリオ全体の状態で出し分け)
  const naviGainPct = portfolioCost>0?portfolioGain/portfolioCost*100:0;
  const holdMaxDays = myHoldings.reduce((mx,h)=>{const d=h.firstBuyDate?(Date.now()-new Date(h.firstBuyDate).getTime())/86400000:0;return d>mx?d:mx;},0);
  const topShare = portfolioVal>0?myHoldings.reduce((mx,h)=>{const st=stocks.find(x=>x.id===h.stockId);const v=st?toPts(st,st.price)*h.qty/portfolioVal:0;return v>mx?v:mx;},0):0;
  const navi = pickInvestNavi(naviGainPct, holdMaxDays, topShare>0.6 && myHoldings.length>1, myHoldings.length>0, Math.floor(Date.now()/10000));
  // 畑ビュー: 銘柄の含み損益で 作物の育ち(土→芽→葉→花/雨)を出す
  const cropEmoji = (gp)=> gp==null?"🟫" : gp>=10?"🌸" : gp>=3?"🌿" : gp>=-3?"🌱" : "🌧";
  // 配当ごはん: 配当が相棒の育てた度に変わった量(可視化用・getMonStateと同じ上限30)
  const divFed = Math.min(30, (data.logs||[]).filter(l=>l.cid===child.id && l.type==="interest" && /配当/.test(l.label||"")).length);
  const divLogs = (data.logs||[]).filter(l=>l.cid===child.id && l.type==="interest");
  const totalDividend = divLogs.reduce((s,l)=>s+(l.pts||0),0);   // 配当でふえた累計
  const lastDividend = divLogs.length>0 ? (divLogs[0].pts||0) : 0; // 直近の配当(logsは新しい順)
  const selStock=stocks.find(s=>s.id===selected);
  const selHolding=myHoldings.find(h=>h.stockId===selected);
  const qtyN=Math.max(0.1,Math.round((parseFloat(qty)||0.1)*10)/10);
  const basePrice=selStock?Math.round(toPts(selStock,selStock.price)*qtyN):0;
  const FEE_RATE = 0.02; // 手数料2%(子ども向けに現実的なネット証券水準へ)
  const costPts = Math.ceil(basePrice*(1+FEE_RATE)); // 購入時：価格+2%手数料
  const sellPts = selStock&&selHolding?Math.floor(toPts(selStock,selStock.price)*qtyN*(1-FEE_RATE)):0; // 売却時：価格-2%手数料

  const fmtQty=q=>(q%1===0)?`${q}`:`${q.toFixed(1)}`;
  function doBuy(){
    if(!selStock||qtyN<0.1||myBal<costPts) return;
    if(tradeLimitReached){ setTradeFlash({msg:`🌙 きょうの 売り買いは ここまで！また あした`,color:"#D95C55"}); setTimeout(()=>setTradeFlash(null),1900); return; }
    if(!txGuard("buy_"+child.id)) return;   // 連打ガード(二重購入防止)
    update(d=>{
      const existH=(d.holdings?.[child.id]||[]).find(h=>h.stockId===selStock.id);
      let newH;
      const tq=Math.round(((existH?.qty||0)+qtyN)*10)/10;
      if(existH){newH=(d.holdings[child.id]).map(h=>h.stockId===selStock.id?{...h,qty:tq,avgPrice:Math.round((existH.avgPrice*existH.qty+costPts)/tq)}:h);}
      else newH=[...(d.holdings?.[child.id]||[]),{stockId:selStock.id,qty:qtyN,avgPrice:Math.round(costPts/qtyN),firstBuyDate:new Date().toISOString()}];
      const commentPart=tradeComment?` ・ ${tradeComment}`:"";
      return{...d,holdings:{...(d.holdings||{}),[child.id]:newH},logs:(()=>{const _e={id:uid(),cid:child.id,type:"invest_buy",label:`📈 ${selStock.emoji}${selStock.name} ${fmtQty(qtyN)}株 購入${commentPart}`,pts:-costPts,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})()};
    });
    setTradeFlash({msg:`🌱 ${selStock.emoji}${selStock.name} の タネをまいた！`,color:"#22c55e"});
    setTimeout(()=>setTradeFlash(null),1700);
    setQty("0.1");setSelected(null);setTradeComment("");
  }
  function doSell(){
    if(!selStock||!selHolding||qtyN<0.1||qtyN>selHolding.qty) return;
    if(tradeLimitReached){ setTradeFlash({msg:`🌙 きょうの 売り買いは ここまで！また あした`,color:"#D95C55"}); setTimeout(()=>setTradeFlash(null),1900); return; }
    if(!txGuard("sell_"+child.id)) return;   // 連打ガード(二重売却防止)
    const _profit=Math.round(sellPts-(selHolding?selHolding.avgPrice*qtyN:0));
    const _invHeld=selHolding?.firstBuyDate?(Date.now()-new Date(selHolding.firstBuyDate).getTime())/86400000:0; // 保有日数(辛抱の度合い)
    if(_profit>=0){ setTradeFlash(_invHeld>=30?{msg:`🌾 ${Math.floor(_invHeld)}日 そだてて 収穫！+${_profit.toLocaleString()}pt`,color:"#E8B83E"}:{msg:`🌱 +${_profit.toLocaleString()}pt 収穫。長く そだてると もっと実るよ`,color:"#34C77B"}); }
    else { setTradeFlash({msg:`🌱 ${_profit.toLocaleString()}pt 収穫。また たねを まこう！`,color:"#D95C55"}); }
    setTimeout(()=>setTradeFlash(null),1700);
    // 収穫フラッシュ(全画面)は「長く育てて勝てた=辛抱」のときだけ。短期の利確では出さない(射幸性カット)
    if(_profit>=0 && _invHeld>=30){ setHarvestBurst({pts:_profit,days:Math.floor(_invHeld)}); setTimeout(()=>setHarvestBurst(null),1300); }
    update(d=>({...d,holdings:{...(d.holdings||{}),[child.id]:(d.holdings[child.id]).map(h=>h.stockId===selStock.id?{...h,qty:Math.round((h.qty-qtyN)*10)/10}:h).filter(h=>h.qty>0)},logs:(()=>{const _e={id:uid(),cid:child.id,type:"invest_sell",label:`📉 ${selStock.emoji}${selStock.name} ${fmtQty(qtyN)}株 売却（手数料2%引後）`,pts:sellPts,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})()}));
    setQty("0.1");setSelected(null);
  }

  return(<div style={{padding:"12px 16px",paddingBottom:32}}>
    {/* 小学生むけ：やさしい はたけの あいさつ（どうぶつの森っぽい ほっこり導入） */}
    {isJr&&(
      <div style={{display:"flex",alignItems:"center",gap:10,background:"linear-gradient(180deg,#eaf7ec,#dff0e4)",border:`2px solid ${G}`,borderRadius:18,padding:"11px 14px",marginBottom:12}}>
        <img src="/assets/tanemon.png" alt="" style={{width:40,height:40,objectFit:"contain",imageRendering:"pixelated",flexShrink:0}} onError={e=>{const s=document.createElement("span");s.textContent="🌱";s.style.fontSize="30px";e.target.replaceWith(s);}}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:900,fontSize:14,color:GP}}>ようこそ、きみの はたけへ！</div>
          <div style={{fontSize:11.5,color:TEXTS,fontWeight:700,lineHeight:1.5,marginTop:1}}>たね（株）を まいて、じっくり そだてよう。あわてて うらなくて だいじょうぶ。まいにち ちょっとずつ おおきくなるよ🌾</div>
        </div>
      </div>
    )}
    {/* 売買の気持ちいい完了トースト(上から落ちて消える) */}
    {tradeFlash&&(
      <div style={{position:"fixed",top:0,left:0,right:0,zIndex:1400,display:"flex",justifyContent:"center",pointerEvents:"none"}}>
        <div style={{marginTop:14,background:tradeFlash.color,color:"#fff",fontWeight:900,fontSize:14,padding:"11px 20px",borderRadius:14,boxShadow:"0 8px 24px rgba(0,0,0,.35)",animation:"tradePop .3s cubic-bezier(.34,1.56,.64,1)"}}>{tradeFlash.msg}</div>
        <style>{`@keyframes tradePop{0%{transform:translateY(-24px);opacity:0}100%{transform:translateY(0);opacity:1}}`}</style>
      </div>
    )}
    {/* 🌾 収穫フラッシュ：長く育てて勝てた時だけの「辛抱ごほうび」演出(射幸性カットのため利確即発火はしない) */}
    {harvestBurst!=null&&(
      <div style={{position:"fixed",inset:0,zIndex:1500,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",pointerEvents:"none",background:"radial-gradient(circle at 50% 45%,rgba(232,184,62,.3),rgba(52,199,123,.16) 55%,transparent 75%)"}}>
        <img src="/assets/tanemon_harvest.png" alt="" style={{width:96,height:96,objectFit:"contain",imageRendering:"pixelated",animation:"harvestBurst 1.1s cubic-bezier(.2,.9,.3,1.2) forwards"}} onError={e=>{const s=document.createElement("span");s.textContent="🌾";s.style.fontSize="64px";e.target.replaceWith(s);}}/>
        <div style={{marginTop:8,fontSize:13,fontWeight:800,color:"#8a6a00",textShadow:"0 1px 6px #fff",animation:"harvestBurst 1.1s .04s cubic-bezier(.2,.9,.3,1.2) forwards"}}>🌾 {harvestBurst.days}日 そだてた ごほうび</div>
        <div style={{marginTop:2,fontSize:22,fontWeight:900,color:"#187A4E",textShadow:"0 2px 8px #fff",animation:"harvestBurst 1.1s .08s cubic-bezier(.2,.9,.3,1.2) forwards"}}>+{harvestBurst.pts.toLocaleString()}pt 収穫！</div>
        <style>{`@keyframes harvestBurst{0%{transform:scale(0) rotate(-8deg);opacity:0}55%{transform:scale(1.15) rotate(4deg);opacity:1}100%{transform:scale(1) rotate(0deg);opacity:0}}`}</style>
      </div>
    )}
    {/* 📖 収穫シール帳・作物図鑑 */}
    {showDex&&(()=>{
      const STAGES=[{k:"seed",th:0,l:"たね"},{k:"0",th:0,l:"め"},{k:"1",th:1,l:"なえ"},{k:"2",th:2,l:"はな"},{k:"3",th:3,l:"みのり"}];
      const dexStocks=stocks.filter(s=>CROP_ART[s.id]!==undefined);
      let got=0,total=0;
      dexStocks.forEach(s=>{const mx=cropDex[s.id]??-1;STAGES.forEach(st=>{total++;if(mx>=st.th&&mx>=0)got++;});});
      return(
      <div onClick={()=>setShowDex(false)} style={{position:"fixed",inset:0,zIndex:1450,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
        <div onClick={e=>e.stopPropagation()} style={{background:BG,borderRadius:20,padding:"16px 14px",maxWidth:380,width:"100%",maxHeight:"86vh",overflowY:"auto",boxShadow:"0 12px 40px rgba(0,0,0,.4)"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
            <img src="/assets/album_icon.png" alt="" style={{width:30,height:30,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent="📖";s.style.fontSize="24px";e.target.replaceWith(s);}}/>
            <div style={{flex:1}}><div style={{fontWeight:900,fontSize:16,color:GP}}>さくもつ ずかん</div><div style={{fontSize:11,fontWeight:800,color:TEXTS}}>そだてた さくもつを あつめよう（{got}/{total}）</div></div>
            <button onClick={()=>setShowDex(false)} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>✕</button>
          </div>
          {dexStocks.map(s=>{
            const mx=cropDex[s.id]??-1;
            return(
              <div key={s.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"9px 10px",marginTop:10}}>
                <div style={{fontWeight:800,fontSize:12,color:TEXT,marginBottom:6}}>{s.emoji} {s.name}</div>
                <div style={{display:"flex",gap:5,justifyContent:"space-between"}}>
                  {STAGES.map(st=>{
                    const ok=mx>=0&&mx>=st.th;
                    const frame=ok?(st.k==="3"?"collect_shiny":"collect_slot"):"collect_locked";
                    return(
                      <div key={st.k} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                        <div style={{position:"relative",width:54,height:54,display:"flex",alignItems:"center",justifyContent:"center"}}>
                          <img src={`/assets/${frame}.png`} alt="" style={{position:"absolute",inset:0,width:54,height:54,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{e.target.style.display="none";}}/>
                          {ok&&<div style={{position:"relative",zIndex:1}}><CropArt stockId={s.id} stage={st.k} emoji={s.emoji} size={32}/></div>}
                        </div>
                        <span style={{fontSize:9,fontWeight:800,color:ok?GP:MUTED}}>{ok?st.l:"？"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div style={{fontSize:10.5,color:MUTED,fontWeight:700,textAlign:"center",marginTop:12,lineHeight:1.6}}>長く そだてるほど 上の シールが もらえるよ🌱<br/>うっても シールは きえないよ</div>
        </div>
      </div>);
    })()}
    {/* 🏡 もようがえ（畑のデコ・あつ森型／レベルで増える） */}
    {showDeco&&(
      <div onClick={()=>setShowDeco(false)} style={{position:"fixed",inset:0,zIndex:1450,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
        <div onClick={e=>e.stopPropagation()} style={{background:BG,borderRadius:20,padding:"16px 14px",maxWidth:380,width:"100%",maxHeight:"86vh",overflowY:"auto",boxShadow:"0 12px 40px rgba(0,0,0,.4)"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:24}}>🏡</span>
            <div style={{flex:1}}><div style={{fontWeight:900,fontSize:16,color:GP}}>もようがえ</div><div style={{fontSize:11,fontWeight:800,color:TEXTS}}>畑を じぶんらしく かざろう（{placedDeco.length}/{decoSlots}コ・Lv.{farmLv}）</div></div>
            <button onClick={()=>setShowDeco(false)} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>✕</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
            {DECO_ITEMS.map(d=>{
              const locked=farmLv<d.lv; const on=placedDeco.includes(d.id);
              return(
                <button key={d.id} disabled={locked} onClick={()=>toggleDeco(d.id)}
                  style={{background:on?GS:CARD,border:on?`2.5px solid ${GP}`:`1.5px solid ${BORDER}`,borderRadius:14,padding:"9px 2px",cursor:locked?"default":"pointer",fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",gap:2,opacity:locked?0.5:1}}>
                  <span style={{fontSize:26,filter:locked?"grayscale(1)":"none"}}>{locked?"🔒":d.e}</span>
                  <span style={{fontSize:9,fontWeight:800,color:locked?MUTED:on?GP:TEXT}}>{locked?`Lv.${d.lv}`:d.n}</span>
                  {on&&<span style={{fontSize:8,fontWeight:900,color:GP}}>おいてる</span>}
                </button>
              );
            })}
          </div>
          <div style={{fontSize:10.5,color:MUTED,fontWeight:700,textAlign:"center",marginTop:12,lineHeight:1.6}}>はたけレベルが 上がると、置ける数と アイテムが ふえるよ🌱<br/>（水やり・なでなで・ログインで レベルアップ）</div>
        </div>
      </div>
    )}
    {/* ポートフォリオ シェアモーダル */}
    {showShare&&(
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:900,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setShowShare(false)}>
        <div style={{background:"linear-gradient(160deg,#060d1a,#0f1a2e)",borderRadius:24,padding:24,maxWidth:340,width:"100%",color:"#fff",boxShadow:"0 24px 60px rgba(0,0,0,0.7)"}} onClick={e=>e.stopPropagation()}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
            <div style={{fontSize:11,color:"#4a9eff",fontWeight:800,letterSpacing:2}}>TANE MONEY</div>
            <button onClick={()=>setShowShare(false)} style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:8,width:28,height:28,cursor:"pointer",color:"rgba(255,255,255,0.6)",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>✕</button>
          </div>
          <div style={{marginBottom:16}}>
            <div style={{color:"rgba(255,255,255,0.4)",fontSize:11,marginBottom:6}}><Emo e={child.emoji} size={13} style={{marginRight:3}}/>{child.name} の投資ポートフォリオ</div>
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
              <div style={{color:"rgba(255,255,255,0.58)",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:10}}>HOLDINGS</div>
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
                      <div style={{color:"rgba(255,255,255,0.58)",fontSize:11}}>{fq}株 · {pct}%</div>
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
              <div style={{color:"rgba(255,255,255,0.58)",fontSize:11,lineHeight:1.6}}>会社の一部を買うこと。価格が上がれば利益が出て、下がれば損になる。下のリストから気になる株をタップして買ってみよう。</div>
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
            const txt=`${(child.emoji||"").startsWith("ico:")?"🧒":child.emoji} ${child.name}のポートフォリオ\n💰 ${portfolioVal.toLocaleString()}pt（損益: ${gainStr}pt）\n${myHoldings.map(h=>{const st=stocks.find(x=>x.id===h.stockId);return st?`${st.emoji}${st.name}`:""}).filter(Boolean).join("・")}\n🌱 tane-money.vercel.app`;
            if(navigator.share){try{await navigator.share({title:"TANE MONEY ポートフォリオ",text:txt});}catch(e){}}
            else{navigator.clipboard?.writeText(txt);setShareCopied(true);setTimeout(()=>setShareCopied(false),2500);}
          }} style={{width:"100%",background:shareCopied?"rgba(74,222,128,0.15)":"#4a9eff",border:shareCopied?"1px solid #4ade80":"none",borderRadius:14,padding:"12px",color:shareCopied?"#4ade80":"#fff",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:F,marginTop:8,transition:"all .3s"}}>
            {shareCopied?"✓ コピーしました！":"📤 LINEで送る / シェア"}
          </button>
          <div style={{textAlign:"center",color:"rgba(255,255,255,0.12)",fontSize:11,letterSpacing:0.5,marginTop:8}}>🌱 tane-money.vercel.app</div>
        </div>
      </div>
    )}
    {/* ===== 🌱 はたけホーム（ゲーム画面）。数字は「とりひき/くら」へ ===== */}
    {!showTrade && (()=>{
      const has=myHoldings.length>0;
      const gp=portfolioCost>0?portfolioGain/portfolioCost*100:0;
      const skyImg=!has?"sky_morning":gp>=0?"sky_noon":"sky_sunset";
      const NEXT=[3,10,30];
      const ripeCount=myHoldings.filter(h=>cropStageDays(holdDaysOf(h))>=3).length;
      return(<div>
        <div style={{display:"flex",gap:7,alignItems:"center",marginBottom:10}}>
          <div style={{flex:1,background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"6px 10px"}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:10,fontWeight:800,color:TEXTS,marginBottom:3}}><span>🌱 はたけ Lv.{farmLv}</span><span>{Math.round(lvProg*100)}%</span></div>
            <div style={{height:6,background:GS,borderRadius:3,overflow:"hidden"}}><div style={{width:`${Math.round(lvProg*100)}%`,height:"100%",background:G}}/></div>
          </div>
          {loginStreak>0&&<div style={{background:GS,border:`1.5px solid ${G}`,borderRadius:12,padding:"7px 8px",fontSize:12,fontWeight:900,color:GP,whiteSpace:"nowrap"}}>📅{loginStreak}</div>}
          <div style={{background:BS,border:`1.5px solid ${B}`,borderRadius:12,padding:"7px 9px",fontSize:12,fontWeight:900,color:B,whiteSpace:"nowrap"}}>💧{waterReserve}</div>
          <div style={{background:GOLDS,border:`1.5px solid ${GOLD}`,borderRadius:12,padding:"7px 9px",fontSize:12,fontWeight:900,color:"#8a6a00",whiteSpace:"nowrap"}}>💰{myBal.toLocaleString()}</div>
        </div>
        <div style={{position:"relative",borderRadius:18,overflow:"hidden",marginBottom:10,border:`3px solid ${G}`,boxShadow:"0 6px 22px rgba(52,199,123,.3)"}}>
          <div style={{height:44,backgroundImage:`url(/assets/${skyImg}.png)`,backgroundSize:"cover",backgroundPosition:"center",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 8px 0 10px"}}>
            <span style={{fontSize:12,fontWeight:900,color:"#5a4a2a",background:"rgba(255,255,255,.65)",borderRadius:8,padding:"3px 9px"}}>🪵 きみの はたけ</span>
            <button onClick={()=>setShowDex(true)} style={{display:"flex",alignItems:"center",gap:4,background:"rgba(255,255,255,.8)",border:"none",borderRadius:9,padding:"4px 9px",cursor:"pointer",fontFamily:F}}>
              <img src="/assets/album_icon.png" alt="" style={{width:18,height:18,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const s=document.createElement("span");s.textContent="📖";e.target.replaceWith(s);}}/>
              <span style={{fontSize:11,fontWeight:900,color:"#3a6a2a"}}>ずかん</span>
            </button>
          </div>
          {/* 🏡 かざり棚（模様替え）。置ける数は はたけレベルで増える */}
          <div onClick={()=>setShowDeco(true)} style={{display:"flex",alignItems:"center",gap:5,background:"linear-gradient(180deg,#bfe6a0,#a6d885)",padding:"4px 8px",cursor:"pointer",overflowX:"auto",borderBottom:"2px solid #8fc070"}}>
            {Array.from({length:decoSlots}).map((_,i)=>{ const it=placedDeco[i]?DECO_ITEMS.find(d=>d.id===placedDeco[i]):null; return <span key={i} style={{fontSize:18,flexShrink:0,opacity:it?1:.45}}>{it?it.e:"・"}</span>; })}
            <span style={{marginLeft:"auto",fontSize:9.5,fontWeight:900,color:"#2f5a22",background:"rgba(255,255,255,.78)",borderRadius:8,padding:"2px 8px",flexShrink:0,whiteSpace:"nowrap"}}>🎨 もようがえ</span>
          </div>
          <div style={{backgroundImage:"url(/assets/soil_tile.png)",backgroundSize:"64px",imageRendering:"pixelated",padding:"10px 8px 12px",display:"flex",gap:7,alignItems:"flex-end",overflowX:"auto"}}>
            {stocks.map(s=>{
              const h=myHoldings.find(x=>x.stockId===s.id);
              const held=!!h; const d=holdDaysOf(h); const stage=cropStageDays(d);
              const ripe=held&&stage>=3;
              const nextIn=(held&&stage<3)?Math.max(1,Math.ceil(NEXT[stage]-d)):0;
              return(
                <button key={s.id} onClick={()=>{ if(ripe){setSelected(s.id);setMode("sell");setQty("0.1");setShowTrade(true);} else if(held){waterCrop(s,h);} else {setSelected(s.id);setMode("buy");setQty("0.1");setTradeComment("");setShowTrade(true);} }}
                  style={{flex:"0 0 auto",width:74,background:"transparent",border:"none",cursor:"pointer",fontFamily:F,padding:0,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                  <div style={{position:"relative",width:66,height:66,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
                    <img src={`/assets/${ripe?"plot_ripe":"plot_empty"}.png`} alt="" style={{position:"absolute",bottom:0,left:3,width:60,height:60,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{e.target.style.display="none";}}/>
                    {held
                      ? <div style={{position:"relative",zIndex:1,marginBottom:8,transformOrigin:"bottom center",...(ripe?{animation:"ripeBounce 1s ease-in-out infinite",filter:"drop-shadow(0 0 7px rgba(232,184,62,.95))"}:{animation:`growSway ${2.2+(s.id.charCodeAt(s.id.length-1)%5)*0.18}s ease-in-out infinite`})}}><CropArt stockId={s.id} stage={stage} emoji={s.emoji} size={54}/></div>
                      : <span style={{position:"relative",zIndex:1,marginBottom:16,fontSize:20,opacity:.85,animation:"plantPulse 1.6s ease-in-out infinite"}}>➕</span>}
                    {ripe&&<span style={{position:"absolute",top:-2,right:4,fontSize:15,animation:"ripeBounce 1s ease-in-out infinite",zIndex:2}}>🌟</span>}
                    {held&&!ripe&&<span style={{position:"absolute",top:0,right:2,fontSize:12,zIndex:2}}>💧</span>}
                  </div>
                  <span style={{fontSize:9.5,fontWeight:900,whiteSpace:"nowrap",borderRadius:999,padding:"2px 7px",...(ripe?{background:GOLD,color:"#fff"}:held?{background:"rgba(255,255,255,.9)",color:GP}:{background:"rgba(255,255,255,.78)",color:"#7a6a3a"})}}>
                    {ripe?"🌟しゅうかく":held?`あと${nextIn}日`:"＋まく"}
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{background:"rgba(24,122,78,.92)",padding:"5px 8px",display:"flex",alignItems:"center",gap:6}}>
            <button onClick={patMon} style={{background:"rgba(255,255,255,.2)",border:"none",borderRadius:10,padding:"3px 7px",cursor:"pointer",display:"flex",alignItems:"center",gap:3,fontFamily:F,flexShrink:0}}>
              <img src="/assets/tanemon_water.png" alt="" style={{width:24,height:24,objectFit:"contain",imageRendering:"pixelated"}} onError={e=>{const sp=document.createElement("span");sp.textContent="🌱";e.target.replaceWith(sp);}}/>
              <span style={{fontSize:9,fontWeight:900,color:"#fff"}}>なでる</span>
            </button>
            <span style={{fontSize:10.5,fontWeight:800,color:"#eafff2",lineHeight:1.4}}>{ripeCount>0?`🌟 ${ripeCount}コ みのった！タップで しゅうかく`:has?"作物を タップで 💧みずやり。タネモンも なでてあげよう":"あいてる畑を タップで タネを まこう！"}</span>
          </div>
          <style>{`@keyframes ripeBounce{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-4px) scale(1.06)}}@keyframes plantPulse{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.18);opacity:1}}@keyframes growSway{0%{transform:rotate(-2.5deg) scaleY(.97)}25%{transform:rotate(0deg) scaleY(1.04)}50%{transform:rotate(2.5deg) scaleY(.99)}75%{transform:rotate(0deg) scaleY(1.05)}100%{transform:rotate(-2.5deg) scaleY(.97)}}`}</style>
        </div>
        <div style={{display:"flex",gap:7}}>
          <button onClick={drawWater} style={{flex:1,background:BS,border:`2px solid ${B}`,borderRadius:14,padding:"9px 6px",cursor:"pointer",fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
            <span style={{fontSize:18}}>🪣</span><span style={{fontSize:11,fontWeight:900,color:B}}>みずをくむ</span><span style={{fontSize:9,fontWeight:800,color:"#4a7"}}>{Math.floor(bucketG)}g たまってる</span>
          </button>
          <button onClick={()=>setShowTrade(true)} style={{flex:1.5,background:GP,border:"none",borderRadius:14,padding:"9px 6px",cursor:"pointer",fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
            <span style={{fontSize:18}}>🏠</span><span style={{fontSize:11,fontWeight:900,color:"#fff"}}>とりひき / くら</span><span style={{fontSize:9,fontWeight:800,color:"#cdeedd"}}>買う・売る・成績を見る</span>
          </button>
        </div>
      </div>);
    })()}

    {/* ===== とりひき/くら（投資の数字・売買リスト）===== */}
    {showTrade && (<>
      <button onClick={()=>setShowTrade(false)} style={{display:"flex",alignItems:"center",gap:6,background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:999,padding:"7px 14px",cursor:"pointer",fontFamily:F,color:GP,fontWeight:900,fontSize:13,marginBottom:12}}>‹ はたけに もどる</button>
    {/* 1日の売り買い回数の残り（保護者設定時のみ） */}
    {tradeLimit>0 && (
      <div style={{textAlign:"center",fontSize:12,fontWeight:800,color:tradeLimitReached?"#ffb4b4":"#bff0c8",background:"rgba(255,255,255,.07)",border:"1px solid rgba(255,255,255,.14)",borderRadius:10,padding:"7px 12px",marginBottom:12}}>
        {tradeLimitReached?"🌙 きょうの 売り買いは ここまで！また あした":`🌱 きょうの 売り買い のこり ${Math.max(0,tradeLimit-tradesToday)}回（保護者せってい）`}
      </div>
    )}
    {/* タブ切替：株 / 為替（為替は保護者設定でOFFにできる） */}
    {!forexOff && (
    <div style={{display:"flex",gap:0,background:"#1a1a2e",borderRadius:14,overflow:"hidden",marginBottom:14}}>
      {[["stocks","📈 株"],["forex","💱 為替"]].map(([v,l])=>(
        <button key={v} onClick={()=>setInvestTab(v)}
          style={{flex:1,padding:"10px 0",border:"none",background:investTab===v?"#4a9eff":"transparent",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>
          {l}
        </button>
      ))}
    </div>
    )}

    {!forexOff&&investTab==="forex"&&<ForexSection data={data} update={update} child={child}/>}

    {(forexOff||investTab==="stocks")&&<>
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

      {/* ポートフォリオ＝きみの畑。損益で「天気/季節」が変わる */}
      <div style={{background:"linear-gradient(135deg,#1a1a2e,#16213e)",borderRadius:20,padding:18,marginBottom:14,color:"#fff"}}>
        {(()=>{const gp=portfolioCost>0?portfolioGain/portfolioCost*100:0;const has=myHoldings.length>0;const se=!has?{sky:"linear-gradient(180deg,#8a6a2a,#a8843a)",ic:"🌱",t:"たねを まこう",c:"#ffe9b0"}:gp>=10?{sky:"linear-gradient(180deg,#1a6b2e,#2e7d44)",ic:"☀",t:"豊作！晴れ",c:"#bff0c8"}:gp>=3?{sky:"linear-gradient(180deg,#3a7fb0,#4a9e7a)",ic:"🌸",t:"春・すくすく育ち中",c:"#d9f0e4"}:gp>=-3?{sky:"linear-gradient(180deg,#8a6a2a,#a8843a)",ic:"🍂",t:"秋・ようすを見よう",c:"#ffe9b0"}:gp>=-10?{sky:"linear-gradient(180deg,#4a5a72,#6b7280)",ic:"❄",t:"冬・たいせつに待とう",c:"#cdd9e6"}:{sky:"linear-gradient(180deg,#2d3748,#553c2a)",ic:"⛈",t:"嵐の日。でも畑は 枯れてないよ",c:"#e6d2c4"};return(
          <div style={{margin:"-18px -18px 12px",padding:"12px 16px 10px",background:se.sky,borderRadius:"20px 20px 0 0",display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:26}}>{se.ic}</span>
            <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:900,color:"#fff"}}>きょうの 畑の天気</div><div style={{fontSize:11,fontWeight:800,color:se.c}}>{se.t}{has?`（${gp>=0?"+":""}${gp.toFixed(1)}%）`:""}</div></div>
            <button onClick={()=>setShowShare(true)} style={{background:"rgba(255,255,255,0.18)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:8,padding:"4px 10px",color:"#fff",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F}}>📸</button>
          </div>);})()}
        <div style={{fontSize:11,color:"#aaa",fontWeight:700,marginBottom:2}}>🌾 きみの畑（ポートフォリオ）</div>
        <div style={{fontSize:28,fontWeight:900,marginBottom:4}}>{portfolioVal.toLocaleString()}pt</div>
        <div style={{display:"flex",gap:16,marginBottom:myHoldings.length>0?12:0}}>
          <div><span style={{color:"#aaa",fontSize:11}}>投資額 </span><span style={{fontWeight:700,fontSize:13}}>{portfolioCost.toLocaleString()}pt</span></div>
          <div><span style={{color:"#aaa",fontSize:11}}>損益 </span><span style={{fontWeight:700,fontSize:13,color:portfolioGain>=0?"#4ade80":"#f87171"}}>{portfolioGain>=0?"+":""}{portfolioGain.toLocaleString()}pt</span>{myHoldings.length>0&&(()=>{const gp=portfolioCost>0?portfolioGain/portfolioCost*100:0;const lab=gp>=10?{t:"🚀 絶好調！",c:"#4ade80"}:gp>=0?{t:"🎉 いい調子！",c:"#4ade80"}:gp>=-5?{t:"😌 まだ大丈夫",c:"#ccc"}:{t:"🌱 長期目線で！",c:"#f5c842"};return <span style={{marginLeft:6,fontSize:11,fontWeight:800,color:lab.c}}>{lab.t}</span>;})()}</div>
        </div>
        {/* 💰 配当でふえた合計（毎週もらえる配当の累計） */}
        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:myHoldings.length>0?12:0,background:"rgba(232,184,62,.14)",border:"1px solid rgba(232,184,62,.4)",borderRadius:12,padding:"8px 11px"}}>
          <span style={{fontSize:16}}>💰</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,color:"#ffe9b0",fontWeight:800}}>配当で ふえた合計（毎週もらえるよ）</div>
            {lastDividend>0&&<div style={{fontSize:10,color:"#cdb88a",fontWeight:700,marginTop:1}}>このまえの配当：+{lastDividend.toLocaleString()}pt</div>}
          </div>
          <span style={{fontSize:17,fontWeight:900,color:"#ffd966",whiteSpace:"nowrap"}}>+{totalDividend.toLocaleString()}pt</span>
        </div>
        {/* 🌱 ポートフォリオが育つ畑(保有数・含み益で 土→芽→葉→花) */}
        {(()=>{const cnt=myHoldings.length;const gp=portfolioCost>0?portfolioGain/portfolioCost*100:0;const st=cnt===0?{e:"🟫",t:"タネをまこう（株を買ってみよう）"}:gp>=10?{e:"🌸",t:"含み益で 花が さいた！"}:cnt>=3?{e:"🌿",t:`${cnt}銘柄を そだて中！`}:{e:"🌱",t:`${cnt}銘柄を そだて中`};return(<div style={{display:"flex",alignItems:"center",gap:9,marginBottom:myHoldings.length>0?12:0,background:"rgba(255,255,255,.05)",borderRadius:12,padding:"7px 11px"}}><span style={{fontSize:24}}>{st.e}</span><span style={{fontSize:11.5,color:"#cfe9d6",fontWeight:700}}>{st.t}</span></div>);})()}
        {myHoldings.length>0&&(()=>{
          const total=portfolioVal||1;
          const colors={"7974.T":"#e4002b","6758.T":"#003087","7203.T":"#eb0a1e","MCD":"#ffc72c","AAPL":"#999"};
          return(<>
            <div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",gap:1,marginBottom:6}}>
              {myHoldings.map(h=>{const st=stocks.find(x=>x.id===h.stockId);if(!st)return null;const pct=toPts(st,st.price)*h.qty/total*100;return<div key={h.stockId} style={{width:`${pct}%`,background:colors[st.ticker]||"#4a9eff",minWidth:3}}/>;  })}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:"2px 10px"}}>
              {myHoldings.map(h=>{const st=stocks.find(x=>x.id===h.stockId);if(!st)return null;const pct=Math.round(toPts(st,st.price)*h.qty/total*100);const fq=h.qty%1===0?`${h.qty}`:`${h.qty.toFixed(1)}`;const cg=cropEmoji((toPts(st,st.price)-h.avgPrice)/Math.max(1,h.avgPrice)*100);return(<div key={h.stockId} style={{display:"flex",alignItems:"center",gap:4,fontSize:11}}><CropArt stockId={st.id} stage={cropStageDays(holdDaysOf(h))} emoji={cg} size={20}/><span style={{color:"#ccc"}}>{st.emoji}{st.name} {fq}株 {pct}%</span></div>);})}
            </div>
          </>);
        })()}
        <div style={{marginTop:8,color:"#aaa",fontSize:11}}>💰 残高: <span style={{color:"#fff",fontWeight:700}}>{myBal.toLocaleString()}pt</span></div>
      </div>

      {/* 🗣 ナビ・タネモンの語り(いろんな視点で投資を語る・損は責めない) */}
      <div style={{display:"flex",alignItems:"flex-start",gap:9,background:CARD,border:`1.5px solid ${navi.c}40`,borderLeft:`4px solid ${navi.c}`,borderRadius:12,padding:"9px 12px",marginBottom:12}}>
        {NAVI_ART[navi.e]
          ? <img src={`/assets/${NAVI_ART[navi.e]}.png`} alt="" style={{width:42,height:42,objectFit:"contain",imageRendering:"pixelated",flexShrink:0}} onError={e=>{const s=document.createElement("span");s.textContent=navi.e;s.style.fontSize="22px";e.target.replaceWith(s);}}/>
          : <span style={{fontSize:22,lineHeight:1.1}}>{navi.e}</span>}
        <div style={{flex:1,minWidth:0}}><div style={{fontSize:10,fontWeight:800,color:navi.c,marginBottom:1}}>{navi.n}</div><div style={{fontSize:12,color:TEXT,fontWeight:700,lineHeight:1.5}}>{navi.line}</div></div>
      </div>

      {/* 🍙 配当ごはん: 配当が相棒の育てた度になっている可視化 */}
      {divFed>0&&(
        <div style={{display:"flex",alignItems:"center",gap:8,background:GOLDS,border:`1.5px solid ${GOLD}`,borderRadius:12,padding:"8px 12px",marginBottom:12}}>
          <span style={{fontSize:18}}>🍙</span>
          <span style={{fontSize:11.5,color:"#8a6a00",fontWeight:800,lineHeight:1.5}}>長く持った配当が 相棒の ごはんに！（育てた度 +{divFed}）</span>
        </div>
      )}

      {/* 銘柄一覧 */}
      <p style={{color:MUTED,fontSize:12,fontWeight:700,marginBottom:10}}>🌾 畑にまける タネ（銘柄・毎日更新）</p>
      {stocks.map(s=>{
        const h=myHoldings.find(x=>x.stockId===s.id);
        const isUp=(s.lastChange||0)>=0;
        const isSel=selected===s.id;
        const showC=showChart===s.id;
        return(<div key={s.id} style={{marginBottom:10}}>
          <button onClick={()=>{setSelected(isSel?null:s.id);setMode("buy");setQty("0.1");setTradeComment("");}}
            style={{width:"100%",background:isSel?"#1a1a2e":CARD,border:`2px solid ${isSel?"#4a9eff":BORDER}`,borderRadius:18,padding:"12px 14px",cursor:"pointer",textAlign:"left",fontFamily:F,transition:"all .2s"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <CropArt stockId={s.id} stage={h?cropStageDays(holdDaysOf(h)):"seed"} emoji={s.emoji} size={40}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:800,fontSize:14,color:isSel?"#fff":TEXT}}>{s.name}</div>
                <div style={{color:isSel?"#aaa":MUTED,fontSize:11}}>{s.sector}</div>
                {s.lastComment&&<div style={{color:isSel?"#888":MUTED,fontSize:11,marginTop:1}}>💬 {s.lastComment}</div>}
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
                <div style={{fontSize:11,color:"#aaa"}}>{toPts(s,s.price).toLocaleString()}pt/株</div>
                <div style={{fontSize:12,fontWeight:700,color:isUp?"#4ade80":"#f87171"}}>{isUp?"▲":"▼"}{Math.abs(s.lastChange||0).toFixed(1)}%</div>
                {s.realData&&<div style={{fontSize:11,color:"#4ade80",fontWeight:700}}>● LIVE</div>}
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
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:11,color:"#666"}}>
                    <span>30日前: {s.currency==="JPY"?`¥${s.history[0]?.toLocaleString()}`:`$${s.history[0]?.toFixed(2)}`}</span>
                    <span>高値: {s.currency==="JPY"?`¥${Math.max(...s.history).toLocaleString()}`:`$${Math.max(...s.history).toFixed(2)}`}</span>
                    <span>安値: {s.currency==="JPY"?`¥${Math.min(...s.history).toLocaleString()}`:`$${Math.min(...s.history).toFixed(2)}`}</span>
                  </div>
                </div>
              ):<span style={{color:"#555",fontSize:11}}>▼ チャートを見る</span>}
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
            {/* 🌱 タネモンのひとこと(値動きに応じて問いかけ＝考える習慣) */}
            {(()=>{const lc=selStock.lastChange||0;const c=lc>3?"きょうは 元気だね！高いときの 買いすぎ 注意！":lc>0?"少し 上がってるよ。どうする？":lc>-3?"下がってるけど、長く 持てば どうなるかな？":"大きく 下がってる！チャンス？リスク？かんがえてみて";return(<div style={{display:"flex",alignItems:"flex-start",gap:7,background:"rgba(52,199,123,0.14)",border:"1px solid rgba(52,199,123,0.3)",borderRadius:12,padding:"8px 11px",marginBottom:12}}><span style={{fontSize:16,lineHeight:1.2}}>🌱</span><span style={{fontSize:12,color:"#bff0c8",fontWeight:700,lineHeight:1.5}}>{c}</span></div>);})()}
            <div style={{display:"flex",gap:0,background:"#0d0d1a",borderRadius:10,overflow:"hidden",marginBottom:12}}>
              {["buy","sell"].map(m=><button key={m} onClick={()=>{setMode(m);setQty("0.1");setTradeComment("");}} style={{flex:1,padding:"9px 0",border:"none",background:mode===m?(m==="buy"?"#22c55e":"#E8B83E"):"transparent",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>{m==="buy"?"🌱 タネをまく":"🌾 収穫する"}</button>)}
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
                <div style={{marginTop:8,fontSize:11,color:"#aaa",marginBottom:4}}>💬 なぜ この タネをまく？（任意）</div>
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
              {mode==="buy"?`🌱 ${fmtQty(qtyN)}株 タネをまく！（${costPts.toLocaleString()}pt）`:`🌾 ${fmtQty(qtyN)}株 収穫する！（${sellPts.toLocaleString()}pt受取）`}
            </button>
          </div>}
        </div>);
      })}
    </>}
    </>)}
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
  {id:"b11",emoji:"🎲",name:"ガチャはかせ",desc:"ガチャを30回引いて確率を体験した",type:"action",check:s=>s.gachaCount>=30},
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
          {b.earned&&<div style={{position:"absolute",top:-6,right:-6,width:18,height:18,borderRadius:"50%",background:G,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",fontWeight:900}}>✓</div>}
          <img src={`/assets/badge_${b.id}.png`} alt={b.name} style={{width:52,height:52,objectFit:"contain",display:"block",margin:"0 auto 6px",borderRadius:8,filter:b.earned?"none":"grayscale(1) opacity(0.35)"}}/>
          <div style={{fontWeight:800,fontSize:12,color:b.earned?TEXT:MUTED,marginBottom:4,lineHeight:1.3}}>{b.name}</div>
          <div style={{fontSize:11,color:MUTED,lineHeight:1.4}}>{b.desc}</div>
        </div>
      ))}
    </div>
  </div>);
}

// ── Tips ──────────────────────────────────────────────
const ALL_TIPS=[
  {id:"t01",cat:"お金のきほん",emoji:"💴",title:"お金ってなに？",body:"お金は「ものやサービスと交換できる券」だよ。昔は貝殻や石が使われていたんだ！",q:"むかし、お金のかわりに 使われていたものは？",o:["貝殻や石","プラスチック","紙のシール"],a:0},
  {id:"t02",cat:"お金のきほん",emoji:"🏦",title:"銀行の仕組み",body:"銀行にお金を預けると、銀行はそのお金を別の人に貸して利息をとる。その一部をあなたに「利子」として払ってくれるよ。",q:"銀行に お金を あずけると もらえるのは？",o:["罰金","利子(りし)","税金"],a:1},
  {id:"t03",cat:"お金のきほん",emoji:"💳",title:"クレジットカードの仕組み",body:"クレジットカードは「後払い」の仕組み。使った分は翌月に口座から引き落とされるよ。使いすぎに注意！",q:"クレジットカードは どんな しくみ？",o:["先払い","後払い","ただ"],a:1},
  {id:"t04",cat:"お金のきほん",emoji:"📊",title:"物価ってなに？",body:"物の値段のことを「物価」という。お金が世の中に増えすぎると物価が上がる「インフレ」が起きるよ。",q:"物の値段が 全体的に 上がることを なんという？",o:["デフレ","インフレ","セール"],a:1},
  {id:"t05",cat:"お金のきほん",emoji:"🌐",title:"為替ってなに？",body:"1ドル=150円のように、国によってお金の価値が違う。この交換レートを「為替」という。円安になると輸入品が高くなるよ。",q:"円安に なると 輸入品の ねだんは？",o:["高くなる","安くなる","変わらない"],a:0},
  {id:"t06",cat:"お金のきほん",emoji:"🧾",title:"税金の種類",body:"消費税・所得税・住民税など税金は種類がたくさん。集まった税金は学校・道路・病院などに使われるよ。",q:"集めた税金は 何に 使われる？",o:["一部の人の おこづかい","学校や道路など みんなのため","会社の もうけ"],a:1},
  {id:"t07",cat:"お金のきほん",emoji:"💰",title:"お金を稼ぐ3つの方法",body:"①労働（働く）②投資（お金を増やす）③事業（商売をする）。この3つを組み合わせると豊かになりやすいよ！",q:"お金を かせぐ 方法に ふくまれないのは？",o:["働く","投資する","ねがいごとする"],a:2},
  {id:"t08",cat:"貯金・節約",emoji:"🐷",title:"貯金のコツ",body:"もらったら先に貯金する「先取り貯金」が効果的。使った残りを貯めようとすると、つい使い切ってしまうよ。",q:"貯金が じょうずに できる コツは？",o:["先に 貯金する","余ったら 貯金","ぜんぶ 使う"],a:0},
  {id:"t09",cat:"貯金・節約",emoji:"📝",title:"家計簿をつけよう",body:"何にいくら使ったか記録するだけで、無駄遣いに気づける。1週間試すだけで節約できる金額がわかるよ！",q:"家計簿を つけると 何が いいの？",o:["お金が 勝手に 増える","むだづかいに 気づける","税金が 0になる"],a:1},
  {id:"t10",cat:"貯金・節約",emoji:"🎯",title:"目標を決めると貯まりやすい",body:"「3000ptでゲームを買う」など具体的な目標があると、貯金が続きやすい。目的のない貯金は途中でやめがちだよ。",q:"貯金が つづきやすいのは どんな とき？",o:["目標を 決めたとき","なんとなく の とき","だれにも 言わない とき"],a:0},
  {id:"t11",cat:"貯金・節約",emoji:"⚖",title:"欲しいvs必要",body:"ものを買う前に「欲しいもの？必要なもの？」と考えよう。欲しいものは後回しにすると、本当に必要かわかるよ。",q:"買う前に 考えると いいことは？",o:["欲しい？ 必要？","だれが 見てる？","何色 かな？"],a:0},
  {id:"t12",cat:"貯金・節約",emoji:"🔄",title:"複利の魔法",body:"利子にさらに利子がつく「複利」はとても強力。100ptを年5%で運用すると20年後には約265ptになるよ！",q:"利子に さらに 利子が つくことを なんという？",o:["単利","複利","金利ゼロ"],a:1},
  {id:"t13",cat:"投資",emoji:"📈",title:"株ってなに？",body:"株は会社の「一部オーナー権」。会社が成長すると株価が上がり、持っているだけで「配当金」ももらえることがあるよ。",q:"株を もつと どうなる？",o:["会社の 一部オーナーに なる","すぐ 社長に なる","タダで 商品が もらえる"],a:0},
  {id:"t14",cat:"投資",emoji:"🎲",title:"リスクとリターン",body:"大きく儲かるものほどリスクも大きい。株より預金は安全だけど増えにくい。自分のリスク許容度を知ることが大切。",q:"大きく もうかる ものは ふつう？",o:["リスクも 大きい","ぜったい 安全","必ず 儲かる"],a:0},
  {id:"t15",cat:"投資",emoji:"🧺",title:"卵は1つのカゴに盛るな",body:"投資の有名な格言。1つの銘柄だけに全部つぎ込むのは危険。複数に分けて投資することを「分散投資」というよ。",q:"「卵は1つの カゴに もるな」の 意味は？",o:["1つに 全部 入れない","卵を 大切に する","カゴを たくさん 買う"],a:0},
  {id:"t16",cat:"投資",emoji:"⏳",title:"長期投資が強い理由",body:"短期の株価は予測できないが、長期的に見ると良い会社の株は成長する傾向がある。焦らずじっくり持つのが基本。",q:"投資の 基本的な 持ち方は？",o:["すぐ 売る","じっくり 長く 持つ","毎日 売り買い する"],a:1},
  {id:"t17",cat:"投資",emoji:"🤔",title:"なぜ企業は株を発行するの？",body:"会社は成長するためのお金が必要。株を売ってお金を集める代わりに、投資家に利益を分けることを約束するよ。",q:"会社が 株を 売る 理由は？",o:["成長の お金を 集めるため","あそぶ ため","税金の ため"],a:0},
  {id:"t18",cat:"投資",emoji:"📉",title:"株が下がるのはなぜ？",body:"業績悪化・経済不安・金利上昇・戦争などが原因。みんなが「将来不安だ」と思うと株を売るので価格が下がるよ。",q:"みんなが 将来 不安だと 思うと 株は？",o:["上がる","下がる","変わらない"],a:1},
  {id:"t19",cat:"社会・経済",emoji:"🌍",title:"世界の経済はつながっている",body:"アメリカで不景気が起きると日本の株も下がる。世界の経済はインターネット同様つながっているんだよ。",q:"アメリカの 不景気は 日本の株に？",o:["関係 ない","えいきょう する","良く する"],a:1},
  {id:"t20",cat:"社会・経済",emoji:"🏭",title:"モノの値段が決まる仕組み",body:"「需要（欲しい人）」と「供給（売りたい量）」のバランスで価格が決まる。欲しい人が多いほど高くなるよ。",q:"ものの ねだんは 何で 決まる？",o:["需要と 供給","じゃんけん","お店の 気分"],a:0},
  {id:"t21",cat:"社会・経済",emoji:"🤖",title:"AIと仕事の未来",body:"AIの発展で一部の仕事はなくなる。でも新しい仕事も生まれる。大切なのは「考える力」と「学び続ける力」だよ。",q:"AI時代に 大切なのは？",o:["考える力・学び続ける力","何も しない こと","暗記 だけ"],a:0},
  {id:"t22",cat:"社会・経済",emoji:"♻",title:"ESG投資ってなに？",body:"環境(E)・社会(S)・企業統治(G)に配慮した企業に投資すること。地球にいい企業を応援しながら増やせるよ。",q:"ESG投資が 大切に するのは？",o:["環境や 社会","スピード だけ","見た目 だけ"],a:0},
  {id:"t23",cat:"社会・経済",emoji:"📱",title:"デジタルマネーの時代",body:"PayPayやクレカで現金を使わない人が増えている。便利な反面、使いすぎに気づきにくいので注意が必要だよ。",q:"キャッシュレスの 注意点は？",o:["使いすぎに 気づきにくい","重くて 持てない","すぐ さびる"],a:0},
  {id:"t24",cat:"働くこと",emoji:"💼",title:"給料ってどう決まる？",body:"スキル・経験・業界・会社の規模などで変わる。同じ仕事でも会社によって全然違うことも。副業も増えているよ。",q:"給料は 同じ仕事でも？",o:["会社で ちがう","ぜんぶ 同じ","くじで 決まる"],a:0},
  {id:"t25",cat:"働くこと",emoji:"🌱",title:"お手伝いは社会の練習",body:"お手伝いは実はすごく大事。責任感・計画性・達成感を学べる。これが将来の仕事への基礎になるよ！",q:"お手伝いで 学べる ことは？",o:["責任感や 計画性","運の よさ だけ","なにも ない"],a:0},
  {id:"t26",cat:"働くこと",emoji:"🤝",title:"価値を作るとお金になる",body:"人が「欲しい・助かる」と思うものを作ったり、サービスを提供したりすることで対価（お金）がもらえるよ。",q:"お金が もらえるのは どんな とき？",o:["人の 役に 立つものを 作る","ただ ねがう","じっと まつ"],a:0},
  {id:"t27",cat:"働くこと",emoji:"📚",title:"勉強がお金につながる理由",body:"知識・スキルは「人的資本」。勉強に使うお金は投資と同じ。学べば学ぶほど将来稼げる可能性が上がるよ。",q:"勉強は 何に つながる？",o:["将来 かせぐ 力","むだ づかい","ただの 運"],a:0},
  {id:"t28",cat:"Tane Money",emoji:"🌱",title:"Tane Moneyのコンセプト",body:"「お金は種」。種を蒔いて育てるように、小さなお手伝いの積み重ねが大きな力になる。毎日コツコツが一番！",q:"Tane Moneyの 考えは？",o:["お金は 種、コツコツ 育てる","一発 大もうけ","運 だめし"],a:0},
  {id:"t29",cat:"Tane Money",emoji:"🏆",title:"ランキングで成長できる理由",body:"家族でランキングを競うことで「やる気」が生まれる。競争ではなく「昨日の自分より成長する」ことが大切。",q:"ランキングで 大切なのは？",o:["昨日の 自分より 成長","1位 いがいは だめ","人を ばかに する"],a:0},
  {id:"t30",cat:"Tane Money",emoji:"🎰",title:"ガチャと上手につきあう",body:"ガチャは「確率」の体験。レアが出るかはランダムで、たくさん引いても必ず当たるわけじゃない。お金は計画的に使い、貯金やコツコツの積み重ねが一番たしかな力になるよ。",q:"ガチャと 上手に つきあうには？",o:["お金は 計画的に、コツコツが 一番","全部 つぎこむ","借金して 引く"],a:0},
];

function TipsSection({ageMode,child,data,update}){
  const [cat,setCat]=useState("すべて");
  const [openId,setOpenId]=useState(null);
  const readIds=(data.tipsRead||{})[child.id]||[];
  const TIP_PTS=5;
  const QUIZ_EXP=5;
  const quizDone=(data.tipsQuiz||{})[child.id]||[];   // クイズ正解済みのtip id
  const [quizPick,setQuizPick]=useState({});          // tipId -> えらんだ選択肢index(セッション中)
  // クイズに正解(初回のみ): モンスターにEXP=お金の知識→ゲームの成長を直結
  const answerQuiz=(tip,idx)=>{
    setQuizPick(p=>({...p,[tip.id]:idx}));
    if(idx===tip.a && !quizDone.includes(tip.id)){
      update(d=>({...d,
        tipsQuiz:{...(d.tipsQuiz||{}),[child.id]:[...((d.tipsQuiz?.[child.id])||[]),tip.id]},
        monsterExp:{...(d.monsterExp||{}),[child.id]:((d.monsterExp?.[child.id])||0)+QUIZ_EXP}
      }));
    }
  };
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
      <div style={{flex:1}}><div style={{fontWeight:800,fontSize:15,color:"#fff"}}>まめちしき</div><div style={{color:"rgba(255,255,255,0.55)",fontSize:11}}>{filtered.length}件 · タップで詳しく読む</div></div>
      <div style={{background:GS,border:`1.5px solid ${G}`,borderRadius:12,padding:"4px 10px",textAlign:"center"}}>
        <div style={{fontWeight:900,fontSize:14,color:GP}}>{totalRead}<span style={{fontSize:11,color:TEXTS}}>/{ALL_TIPS.length}</span></div>
        <div style={{fontSize:11,color:TEXTS}}>読了</div>
      </div>
      <div style={{background:PS,border:`1.5px solid ${P}`,borderRadius:12,padding:"4px 10px",textAlign:"center"}}>
        <div style={{fontWeight:900,fontSize:14,color:P}}>{quizDone.filter(id=>ALL_TIPS.find(t=>t.id===id)).length}<span style={{fontSize:11,color:TEXTS}}>/{ALL_TIPS.length}</span></div>
        <div style={{fontSize:11,color:TEXTS}}>クイズ正解</div>
      </div>
    </div>
    <div style={{background:GOLDS,border:`1.5px solid ${Y}`,borderRadius:12,padding:"8px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <span style={{fontSize:12,color:"#7a5a00",fontWeight:700}}><Ico name="books" fb="📚" size={14} style={{marginRight:4}}/>読んで獲得したpt</span>
      <span style={{fontWeight:900,fontSize:15,color:Y}}>+{(totalRead*TIP_PTS).toLocaleString()}pt</span>
    </div>
    <div style={{marginBottom:14}}><SortBar options={cats.filter(c=>ageCats?ageCats.includes(c)||c==="すべて":true).map(c=>[c,c])} value={cat} onChange={setCat}/></div>
    {filtered.map(tip=>{
      const isOpen=openId===tip.id;
      const isRead=readIds.includes(tip.id);
      return(<button key={tip.id} onClick={()=>handleOpen(tip.id)}
        style={{width:"100%",background:isOpen?BS:isRead?GS:CARD,border:`1.5px solid ${isOpen?B:isRead?G:BORDER}`,borderRadius:16,padding:"13px 14px",marginBottom:8,textAlign:"left",cursor:"pointer",fontFamily:F,transition:"all .2s"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22,flexShrink:0}}>{tip.emoji}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:13,color:isOpen?B:TEXT}}>{tip.title}</div>
            <div style={{display:"flex",gap:6,marginTop:3,alignItems:"center"}}>
              <span style={{background:`${B}20`,color:B,padding:"1px 6px",borderRadius:8,fontWeight:700,fontSize:11}}>{tip.cat}</span>
              {!isRead&&<span style={{background:`${Y}20`,color:"#9a7000",padding:"1px 6px",borderRadius:8,fontWeight:700,fontSize:11}}>+{TIP_PTS}pt</span>}
              {isRead&&<span style={{color:G,fontSize:11,fontWeight:700}}>✓ 読んだ</span>}
            </div>
          </div>
          <span style={{color:MUTED,fontSize:14,flexShrink:0,transform:isOpen?"rotate(180deg)":"none",transition:"transform .2s"}}>▼</span>
        </div>
        {isOpen&&<div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${B}30`,fontSize:13,color:TEXT,lineHeight:1.8,fontWeight:500}}>
          {tip.body}
          {!isRead&&<div style={{marginTop:8,background:`${G}15`,border:`1px solid ${G}`,borderRadius:8,padding:"6px 10px",display:"inline-block",fontSize:12,color:G,fontWeight:700}}>🎉 +{TIP_PTS}pt ゲット！</div>}
          {/* 💡→🎮 再接続: 読んだあとのミニクイズ。正解でモンスターにEXP */}
          {tip.q&&(()=>{
            const mastered=quizDone.includes(tip.id);
            const picked=quizPick[tip.id];
            const reveal=mastered||picked!=null;
            return (
              <div onClick={e=>e.stopPropagation()} style={{marginTop:12,background:CARDS,border:`1px solid ${BORDER}`,borderRadius:12,padding:"11px 12px"}}>
                <div style={{fontSize:12.5,fontWeight:800,color:TEXT,marginBottom:9}}>🧠 クイズ：{tip.q}</div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {tip.o.map((opt,i)=>{
                    const isCorrect=i===tip.a, isPicked=picked===i;
                    let bg=CARD,bd=BORDER,col=TEXT;
                    if(reveal&&isCorrect){bg=GS;bd=G;col=GP;}
                    else if(reveal&&isPicked&&!isCorrect){bg=RS;bd=R;col=R;}
                    return (
                      <div key={i} role="button" onClick={e=>{e.stopPropagation(); if(!mastered) answerQuiz(tip,i);}}
                        style={{display:"flex",alignItems:"center",gap:8,background:bg,border:`1.5px solid ${bd}`,borderRadius:10,padding:"9px 11px",cursor:mastered?"default":"pointer",fontFamily:F}}>
                        <span style={{flex:1,fontSize:12.5,fontWeight:700,color:col}}>{opt}</span>
                        {reveal&&isCorrect&&<span style={{fontSize:14}}>⭕</span>}
                        {reveal&&isPicked&&!isCorrect&&<span style={{fontSize:14}}>❌</span>}
                      </div>
                    );
                  })}
                </div>
                {mastered
                  ? <div style={{marginTop:9,fontSize:12,color:GP,fontWeight:800}}>✓ せいかい！ モンスターに +{QUIZ_EXP}EXP（かくとくずみ）</div>
                  : picked!=null
                  ? (picked===tip.a
                      ? <div style={{marginTop:9,fontSize:12,color:GP,fontWeight:800}}>✨ せいかい！ モンスターに +{QUIZ_EXP}EXP！</div>
                      : <div style={{marginTop:9,fontSize:12,color:R,fontWeight:700}}>ざんねん！ もう一度 本文を 読んで えらんでみよう</div>)
                  : <div style={{marginTop:9,fontSize:11,color:MUTED,fontWeight:600}}>正解すると モンスターに EXPが もらえるよ</div>}
              </div>
            );
          })()}
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
          <h3 style={{fontWeight:900,fontSize:17,margin:0,color:TEXT}}><Emo e={child.emoji} size={17} style={{marginRight:4}}/>マイタスクリスト</h3>
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


// ── Default Fallback Tasks (タスク未選択時のデフォルト) ──
const DEFAULT_FALLBACK_TASKS = [
  {id:"df01",emoji:"📝",label:"宿題をする",pts:50,over:{}},
  {id:"df02",emoji:"🍽",label:"食器を洗う",pts:20,over:{}},
  {id:"df03",emoji:"🧹",label:"掃除機をかける",pts:30,over:{}},
  {id:"df04",emoji:"⏰",label:"決めた時間に起きる",pts:20,over:{}},
  {id:"df05",emoji:"🗑",label:"ゴミを捨てる",pts:10,over:{}},
  {id:"df06",emoji:"🧺",label:"洗濯物を畳む",pts:15,over:{}},
  {id:"df07",emoji:"🛁",label:"お風呂掃除をする",pts:20,over:{}},
  {id:"df08",emoji:"🌙",label:"決めた時間に寝る",pts:15,over:{}},
];

// ── Task Templates (初回セットアップ用) ──────────────
const TASK_TEMPLATES = {
  junior: [
    { cat:"📚 勉強", tasks:[
      {id:"tj01",emoji:"📝",label:"宿題をする",pts:50},
      {id:"tj02",emoji:"📖",label:"音読をする（10分）",pts:20},
      {id:"tj03",emoji:"✏",label:"ドリルを1ページやる",pts:30},
      {id:"tj04",emoji:"🔤",label:"漢字練習をする",pts:25},
      {id:"tj05",emoji:"🔢",label:"計算練習をする",pts:25},
    ]},
    { cat:"🏠 お手伝い", tasks:[
      {id:"tj06",emoji:"🗑",label:"ゴミを捨てる",pts:10},
      {id:"tj07",emoji:"🍽",label:"食器を洗う",pts:20},
      {id:"tj08",emoji:"🧺",label:"洗濯物を畳む",pts:15},
      {id:"tj09",emoji:"🛁",label:"お風呂掃除をする",pts:20},
      {id:"tj10",emoji:"🍳",label:"ご飯の準備を手伝う",pts:25},
      {id:"tj11",emoji:"🧹",label:"掃き掃除をする",pts:20},
    ]},
    { cat:"😴 生活習慣", tasks:[
      {id:"tj12",emoji:"⏰",label:"自分で起きる",pts:15},
      {id:"tj13",emoji:"🌙",label:"決めた時間に寝る",pts:15},
      {id:"tj14",emoji:"🪥",label:"歯磨きをする",pts:10},
      {id:"tj15",emoji:"👋",label:"あいさつをする",pts:5},
    ]},
  ],
  teen: [
    { cat:"📚 勉強", tasks:[
      {id:"tt01",emoji:"📝",label:"宿題をする",pts:50},
      {id:"tt02",emoji:"📖",label:"自主学習（30分）",pts:60},
      {id:"tt03",emoji:"📒",label:"復習・予習をする",pts:60},
      {id:"tt04",emoji:"🔤",label:"単語を10個覚える",pts:30},
      {id:"tt05",emoji:"📐",label:"苦手科目を1時間勉強",pts:100},
    ]},
    { cat:"🏠 お手伝い", tasks:[
      {id:"tt06",emoji:"🗑",label:"ゴミ出しをする",pts:15},
      {id:"tt07",emoji:"🍽",label:"食器洗いをする",pts:20},
      {id:"tt08",emoji:"🧹",label:"掃除機をかける",pts:30},
      {id:"tt09",emoji:"🧺",label:"洗濯物を畳む",pts:15},
      {id:"tt10",emoji:"🛁",label:"お風呂掃除をする",pts:20},
      {id:"tt11",emoji:"🍳",label:"料理を手伝う",pts:35},
    ]},
    { cat:"😴 生活習慣", tasks:[
      {id:"tt12",emoji:"⏰",label:"決めた時間に起きる",pts:20},
      {id:"tt13",emoji:"🌙",label:"決めた時間に寝る",pts:20},
      {id:"tt14",emoji:"📵",label:"スマホを指定時間に置く",pts:30},
      {id:"tt15",emoji:"📚",label:"読書（30分）",pts:25},
    ]},
  ],
  parent: [
    { cat:"🏠 家事（親）", tasks:[
      {id:"tp01",emoji:"🍳",label:"夕食を作る",pts:50,parentOnly:true},
      {id:"tp02",emoji:"🧹",label:"掃除機をかける",pts:30,parentOnly:true},
      {id:"tp03",emoji:"👔",label:"洗濯をする・干す",pts:30,parentOnly:true},
      {id:"tp04",emoji:"🛒",label:"買い物をする",pts:20,parentOnly:true},
      {id:"tp05",emoji:"🍽",label:"食器洗いをする",pts:20,parentOnly:true},
      {id:"tp06",emoji:"🗑",label:"ゴミ出し",pts:10,parentOnly:true},
    ]},
    { cat:"💪 自己管理（親）", tasks:[
      {id:"tp07",emoji:"🏃",label:"運動をする（30分）",pts:50,parentOnly:true},
      {id:"tp08",emoji:"⏰",label:"早起きする（6時台）",pts:30,parentOnly:true},
      {id:"tp09",emoji:"🏠",label:"残業せず定時退社",pts:100,parentOnly:true},
      {id:"tp10",emoji:"📵",label:"寝る前スマホを控える",pts:30,parentOnly:true},
    ]},
  ],
};

// ── Setup Wizard ──────────────────────────────────────
function SetupWizard({ data, update, onComplete }) {
  const [step,        setStep]       = useState(0);
  const [familyName,  setFamilyName] = useState("");
  const [childName,   setChildName]  = useState("");
  const [childEmoji,  setChildEmoji] = useState("⚡");
  const [childMode,   setChildMode]  = useState("teen");
  const [parentJoin,  setParentJoin] = useState(false);  // true/false
  const [parentName,  setParentName] = useState("");
  const [parentEmoji, setParentEmoji]= useState("👨");
  const [tmplCat,     setTmplCat]    = useState(0);
  const [selTasks,    setSelTasks]   = useState([]);    // task objects
  const [goalEmoji,   setGoalEmoji]  = useState("🎮");
  const [goalLabel,   setGoalLabel]  = useState("");
  const [goalTarget,  setGoalTarget] = useState("");
  const [goalSkipped, setGoalSkipped]= useState(false);
  const [notifDone,   setNotifDone]  = useState(false);

  const [familyCode] = useState(()=>{
    // 暗号学的乱数で8文字（ゼロ・オー等の紛らわしい文字を除外）。旧形式(4文字)は約168万通りで総当たり可能だった
    const chars="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let c="";
    try{
      const buf=new Uint32Array(8); crypto.getRandomValues(buf);
      for(let i=0;i<8;i++) c+=chars[buf[i]%chars.length];
    }catch(e){ for(let i=0;i<8;i++) c+=chars[Math.floor(Math.random()*chars.length)]; }
    return `TANE-${c.slice(0,4)}-${c.slice(4)}`;
  });
  const [joinMode, setJoinMode] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinErr,  setJoinErr]  = useState("");

  const CHILD_EMOJIS  = ["⚡","🌸","🌟","🦁","🐯","🐬","🦊","🐼","🐉","🌈","🎸","⚽","🚀","🎮","🦄","🐶","🐱","🍕"];
  const PARENT_EMOJIS = ["👨","👩","🧑","👨💼","👩💼","🧔","👴","👵","🦸","🧙","🎅","🦹"];
  const GOAL_EMOJIS   = ["🎮","📱","🎵","🚴","✈","👟","📚","🎨","⚽","🍰","💻","🎸","🏊","🎀","🌍","🍜"];

  const tmplGroups = [
    ...TASK_TEMPLATES[childMode],
    ...(parentJoin ? TASK_TEMPLATES.parent : []),
  ];

  const toggleTask = (task) => setSelTasks(prev =>
    prev.some(t=>t.id===task.id) ? prev.filter(t=>t.id!==task.id) : [...prev, task]
  );

  const handleComplete = (skipGoal=false, parentPin="0000") => {
    const childId  = uid();
    const parentId = uid();

    const newChild = {
      id:childId, name:childName.trim()||"こども", emoji:childEmoji,
      pinh:pinHash("0000"), displayMode:childMode, role:"child",
      gradeLabel:childMode==="junior"?"小学生":"中学生",
      ageMode:childMode==="junior"?"young":"middle",
      permissions:{canChangePin:true,canViewBalance:true,canCreateGoals:true,canRedeemRewards:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"},
    };

    const newParent = parentJoin && parentName.trim() ? {
      id:parentId, name:parentName.trim(), emoji:parentEmoji,
      pinh:pinHash(parentPin), displayMode:"adult", role:"parent", gradeLabel:"",
      participationMode:"player_and_guardian",
      permissions:{investment:"trade",forex:"trade",dailyBonus:true,ranking:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"},
    } : null;

    const goodTasksFromTmpl = selTasks.length > 0
      ? selTasks.map(({parentOnly, ...rest}) => ({...rest, over:{}}))
      : DEFAULT_FALLBACK_TASKS;

    const childTaskIds = selTasks.filter(t=>!t.parentOnly).map(t=>t.id);

    const newGoal = !skipGoal && goalLabel.trim() && parseInt(goalTarget)>0
      ? {id:uid(),cid:childId,emoji:goalEmoji,label:goalLabel.trim(),target:parseInt(goalTarget),done:false}
      : null;
    const bonusLog = {id:uid(),cid:childId,type:"grant",label:"🎉 タネマネースタートボーナス！",pts:100,date:new Date().toISOString()};

    try { localStorage.setItem(FAMILY_CODE_KEY, familyCode); } catch(e){}
    _familyCode = familyCode;

    update(d=>({
      ...d,
      familyName: familyName.trim()||"わが家",
      children:[newChild],
      parents:newParent ? [newParent] : [],
      goodTasks:goodTasksFromTmpl,
      goals:newGoal?[newGoal]:[],
      myTaskIds:childTaskIds.length>0?{[childId]:childTaskIds}:{},
      tutorialSeen:{[childId]:true},
      setupComplete:true,
      parentPinH:pinHash(parentPin||"0000"),
      logs:[bonusLog],
      gachaDate:{}, streak:{},
      firstActionPending:true,
    }));
    addLogToFirestore(bonusLog);
    onComplete("create");
  };

  const btnStyle = (ok) => ({
    width:"100%",background:ok?GP:BORDER,border:"none",borderRadius:16,
    padding:"15px",color:ok?"#fff":MUTED,fontWeight:900,fontSize:16,
    cursor:ok?"pointer":"default",fontFamily:F,transition:"all .2s",
  });

  return (
    <div style={{minHeight:"100vh",background:`linear-gradient(160deg,${GS} 0%,#fff 50%,${GOLDS} 100%)`,fontFamily:F,display:"flex",flexDirection:"column",padding:"56px 24px 40px",maxWidth:480,margin:"0 auto",boxSizing:"border-box"}}>

      {/* プログレスバー (step 1〜6) ドット表示 */}
      {step>=1&&step<=6&&(
        <div style={{marginBottom:28}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            {/* ドット */}
            <div style={{display:"flex",gap:7}}>
              {[1,2,3,4,5,6].map(i=>(
                <div key={i} style={{width:i===step?20:8,height:8,borderRadius:999,background:i<=step?GP:BORDER,transition:"all .3s ease"}}/>
              ))}
            </div>
            <span style={{fontSize:11,color:MUTED,fontWeight:700}}>{step} / 6</span>
            {step>1&&<button onClick={()=>setStep(s=>s-1)} style={{background:"none",border:"none",color:GP,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F}}>← もどる</button>}
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
                placeholder="TANE-XXXX-XXXX"
                style={{...{width:"100%",padding:"12px 14px",border:`1.5px solid ${joinErr?R:BORDER}`,borderRadius:10,fontSize:16,fontFamily:F,background:BG,outline:"none",textAlign:"center",letterSpacing:3,fontWeight:900,color:GP,boxSizing:"border-box"},marginBottom:8}}/>
              {joinErr&&<p style={{color:R,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>{joinErr}</p>}
              <button onClick={()=>{
                const code=joinCode.trim();
                if(!code||code.length<4){setJoinErr("コードを入力してください");return;}
                try{localStorage.setItem(FAMILY_CODE_KEY,code);}catch(e){}
                _familyCode=code;
                onComplete("join");
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
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>かぞくのなまえを決めよう！</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 22px",lineHeight:1.6}}>みんなで使うグループの名前です。あとで変えることもできます</p>
          <input value={familyName} onChange={e=>setFamilyName(e.target.value)}
            placeholder="例：田中家、スマイルファミリー"
            style={{...INP,fontSize:15,marginBottom:14}}/>
          {familyName.trim()&&(
            <div style={{background:GS,border:`1.5px solid ${G}`,borderRadius:14,padding:"12px 16px",marginBottom:22}}>
              <div style={{fontSize:11,color:MUTED,marginBottom:4}}>ファミリーコード（家族の合言葉）</div>
              <div style={{fontWeight:900,fontSize:17,color:GP,letterSpacing:1.5}}>{familyCode}</div>
              <div style={{fontSize:11,color:TEXTS,marginTop:6,lineHeight:1.6}}>家族のスマホでこのコードを入力すると、同じデータを一緒に使えます。<b>スクリーンショットかメモで保存しておいてください</b>（設定画面でいつでも確認できます）</div>
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
          <div style={{display:"flex",gap:8,marginBottom:6}}>
            {[["junior","小学生","かんたん表示"],["teen","中学生・高校生","投資・家計簿つき"]].map(([v,l,desc])=>(
              <button key={v} onClick={()=>setChildMode(v)} style={{flex:1,padding:"11px 0",border:`2px solid ${childMode===v?GP:BORDER}`,borderRadius:12,background:childMode===v?`${GP}15`:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F,color:childMode===v?GP:MUTED,transition:"all .15s"}}>
                {l}<br/><span style={{fontSize:11,fontWeight:600,color:MUTED}}>{desc}</span>
              </button>
            ))}
          </div>
          <p style={{color:MUTED,fontSize:11,margin:"0 0 22px"}}>あとから設定画面で変更できます</p>
          <button onClick={()=>setStep(3)} style={btnStyle(!!childName.trim())} disabled={!childName.trim()}>
            つぎへ →
          </button>
        </div>
      )}

      {/* Step 3: 親参加 */}
      {step===3&&(
        <div style={{flex:1}}>
          <div style={{marginBottom:14}}><Ico name="trophy" fb="🏆" size={48}/></div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>親も参加しますか？</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 6px",lineHeight:1.6}}>
            子どもと一緒にポイントを貯めてランキングで競えます
          </p>
          <p style={{color:MUTED,fontSize:11,margin:"0 0 18px"}}>参加しなくても管理機能はすべて使えます</p>
          <div style={{display:"flex",gap:10,marginBottom:20}}>
            <button onClick={()=>{setParentJoin(false);setTmplCat(0);setStep(4);}}
              style={{flex:1,padding:"16px 0",border:`2.5px solid ${parentJoin===false?GP:BORDER}`,borderRadius:16,background:parentJoin===false?`${GP}12`:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F,color:parentJoin===false?GP:TEXT,transition:"all .15s",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
              <span style={{fontSize:28}}>👀</span>
              <span>管理のみ（見るだけ）</span>
            </button>
            <button onClick={()=>setParentJoin(true)}
              style={{flex:1,padding:"16px 0",border:`2.5px solid ${parentJoin===true?B:BORDER}`,borderRadius:16,background:parentJoin===true?`${B}12`:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F,color:parentJoin===true?B:TEXT,transition:"all .15s",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
              <span style={{fontSize:28}}>🙋</span>
              <span>一緒に参加！</span>
            </button>
          </div>
          {parentJoin===true&&(
            <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"16px",marginBottom:16}}>
              <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8}}>絵文字を選ぼう</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:14}}>
                {PARENT_EMOJIS.map(e=>(
                  <button key={e} onClick={()=>setParentEmoji(e)} style={{width:42,height:42,borderRadius:11,border:`2.5px solid ${parentEmoji===e?B:BORDER}`,background:parentEmoji===e?`${B}18`:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {e}
                  </button>
                ))}
              </div>
              <input value={parentName} onChange={e=>setParentName(e.target.value)}
                placeholder="名前（例：お父さん、ゆうた）"
                style={{...INP,fontSize:15}}/>
            </div>
          )}
          {parentJoin===true&&(
            <button onClick={()=>{setTmplCat(0);setStep(4);}} style={btnStyle(!!parentName.trim())} disabled={!parentName.trim()}>
              つぎへ →
            </button>
          )}
        </div>
      )}

      {/* Step 4: タスクテンプレートを選ぶ */}
      {step===4&&(
        <div style={{flex:1,display:"flex",flexDirection:"column"}}>
          <div style={{fontSize:48,marginBottom:14}}>📋</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 4px"}}>タスクを選ぼう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 6px",lineHeight:1.6}}>
            ポイントを割り振りたい項目をチェック<br/>（あとで自由に編集できます）
          </p>
          <div style={{fontSize:11,color:MUTED,marginBottom:10}}>pt＝ポイント（お手伝いで貯まる単位）</div>
          <div style={{display:"flex",gap:6,marginBottom:6,overflowX:"auto",paddingBottom:2}}>
            {tmplGroups.map((g,i)=>(
              <button key={i} onClick={()=>setTmplCat(i)} style={{flexShrink:0,padding:"7px 14px",border:`2px solid ${tmplCat===i?GP:BORDER}`,borderRadius:999,background:tmplCat===i?`${GP}12`:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,color:tmplCat===i?GP:MUTED,whiteSpace:"nowrap",transition:"all .15s"}}>
                {g.cat}
              </button>
            ))}
          </div>
          {tmplGroups.length > 1 && (
            <div style={{fontSize:13,color:MUTED,textAlign:"right",marginBottom:6}}>← スワイプで他のカテゴリを見る</div>
          )}
          <div style={{flex:1,overflowY:"auto",maxHeight:320,marginBottom:10}}>
            {(tmplGroups[tmplCat]?.tasks||[]).map(t=>{
              const sel=selTasks.some(s=>s.id===t.id);
              const col=t.parentOnly?B:GP;
              return(
                <button key={t.id} onClick={()=>toggleTask(t)}
                  style={{width:"100%",marginBottom:8,background:sel?`${col}12`:"#fff",border:`2px solid ${sel?col:BORDER}`,borderRadius:13,padding:"11px 14px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left",fontFamily:F,transition:"all .15s"}}>
                  <span style={{fontSize:22,flexShrink:0}}>{t.emoji}</span>
                  <span style={{flex:1,fontWeight:700,fontSize:13,color:sel?col:TEXT}}>{t.label}</span>
                  <span style={{fontSize:12,color:col,fontWeight:800,flexShrink:0}}>+{t.pts}pt</span>
                  {sel&&<span style={{color:col,fontSize:16,fontWeight:900,flexShrink:0}}>✓</span>}
                </button>
              );
            })}
          </div>
          <div style={{fontSize:12,color:MUTED,textAlign:"center",marginBottom:10}}>
            {selTasks.length > 0 ? `${selTasks.length}個を選択中` : "スキップするとあとで追加できます"}
          </div>
          <button onClick={()=>setStep(5)} style={btnStyle(true)}>
            {selTasks.length===0?"スキップ →":`${selTasks.length}個で決定 → つぎへ`}
          </button>
        </div>
      )}

      {/* Step 5: 最初の目標 */}
      {step===5&&(
        <div style={{flex:1}}>
          <div style={{marginBottom:14}}><Ico name="target" fb="🎯" size={48}/></div>
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
          <button onClick={()=>{setGoalSkipped(false);setStep(6);}} style={{...btnStyle(true),marginBottom:10,background:GP,boxShadow:`0 6px 20px ${GP}40`}}>
            次へ → PIN設定
          </button>
          <button onClick={()=>{setGoalSkipped(true);setStep(6);}} style={{width:"100%",background:"transparent",border:"none",color:MUTED,fontSize:13,cursor:"pointer",fontFamily:F,fontWeight:700,padding:"6px"}}>
            スキップしてPIN設定へ
          </button>
        </div>
      )}

      {/* Step 6: おや用PIN設定 */}
      {step===6&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center"}}>
          <div style={{fontSize:56,marginBottom:16}}>🔐</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 8px"}}>おや用PINを設定しよう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 28px",lineHeight:1.7}}>子どもに見られないよう<br/>4けたの番号を決めよう</p>
          {!notifDone&&"Notification" in window&&Notification.permission==="default"&&(
            <div style={{width:"100%",background:GS,border:`1.5px solid ${G}`,borderRadius:16,padding:"14px 16px",marginBottom:20,textAlign:"left",boxSizing:"border-box"}}>
              <div style={{fontWeight:800,fontSize:13,color:GP,marginBottom:6}}>🔔 毎日のリマインドを受け取る</div>
              <div style={{color:TEXTS,fontSize:12,lineHeight:1.7,marginBottom:10}}>
                「今日のお手伝いを忘れずに」などの通知を受け取れます
              </div>
              <button onClick={async()=>{
                await Notification.requestPermission();
                setNotifDone(true);
              }} style={{background:GP,border:"none",borderRadius:10,padding:"9px 20px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>
                通知を許可する
              </button>
              <button onClick={()=>setNotifDone(true)} style={{background:"none",border:"none",color:MUTED,fontSize:11,cursor:"pointer",fontFamily:F,marginLeft:12}}>スキップ</button>
            </div>
          )}
          <PinInput onDone={pin=>handleComplete(goalSkipped,pin)}/>
          <button onClick={()=>handleComplete(goalSkipped,"0000")} style={{width:"100%",background:"transparent",border:"none",color:MUTED,fontSize:12,cursor:"pointer",fontFamily:F,fontWeight:700,padding:"20px 0 0"}}>
            スキップして後で設定する
          </button>
          <div style={{marginTop:24,background:GS,border:`1.5px solid ${G}`,borderRadius:16,padding:"14px 16px",textAlign:"left",width:"100%",boxSizing:"border-box"}}>
            <div style={{fontWeight:800,fontSize:13,color:GP,marginBottom:6}}>📱 ホーム画面に追加すると便利！</div>
            <div style={{color:TEXTS,fontSize:12,lineHeight:1.7}}>
              ブラウザの「共有」→「ホーム画面に追加」でアプリのようにすぐ開けます
            </div>
          </div>
          <div style={{background:BS,border:`1.5px solid ${B}40`,borderRadius:14,padding:"13px 16px",marginBottom:14,textAlign:"left"}}>
            <div style={{fontWeight:800,fontSize:13,color:B,marginBottom:6}}>☁ データは自動でクラウドに保存されます</div>
            <div style={{color:TEXTS,fontSize:12,lineHeight:1.7}}>
              端末を変えてもファミリーコードで復元できます。子どもがはじめて自分のカードをタップすると、自分で暗証番号を決めます
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tutorial ──────────────────────────────────────────
// 15秒オンボーディング：お金の基本ループ「お手伝い→ポイント→ためる」だけを3枚で伝える。
// （ガチャ・投資はアプリ内で自然に出会う。最初は核だけ教えて迷わせない）
const CHILD_TUTORIAL = [
  {
    emoji:"🌱", title:"3ステップだけ おぼえよう",
    body:"① お手伝いをする → ② ポイントがたまる → ③ ためて 好きなものと交換！ これがTaneMoneyだよ。",
    hint:"むずかしくないよ。15秒で読めるよ🌟"
  },
  {
    emoji:"🏆", title:"① お手伝いでポイント",
    body:"「活動」タブを開いて、やったお手伝いをタップ。ポイントがどんどん貯まるよ！",
    hint:"正直に記録するのが いちばん大事💪"
  },
  {
    emoji:"🐷", title:"② ためて ③ 交換しよう",
    body:"すぐ使わず コツコツ貯めるのがコツ。「お金」タブで目標を決めて、貯まったら「こうかん」でご褒美と交換！",
    hint:"目標を決めて貯めると達成感が大きいよ🎯"
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
  // リアルタイム同期＋5秒ポーリングの開始（マウント時と、セットアップ完了直後の両方から呼ぶ）
  // ※従来はマウントeffect内に閉じていたため、セットアップ完了後に同期が永遠に始まらないバグがあった
  const pollRef = useRef(null);
  const startSync = useCallback(()=>{
    whenFirebaseReady(()=>{
      if(!getFamilyCode()) return;
      startRealtimeSync((updater)=>{
        setData(prev => typeof updater === 'function' ? updater(prev) : updater);
      });
      startLogsRealtimeSync(setData);
      // 5秒ごとにFirestoreから最新ログを取得（確実な同期）
      if(pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async()=>{
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
    });
  },[]);

  useEffect(()=>{
    // _familyCodeをlocalStorageから直接設定してからcloudLoadを呼ぶ
    try {
      const code = localStorage.getItem("tane_money_family_code");
      if(code) { _familyCode = code; }
    } catch(e) {}

    // ① ローカル即時表示：手元にデータがあればネットを待たずに描画（起動高速化）
    let shownLocal = false;
    let localData = null;   // 起動時のFirestore上書きから お手伝い項目を守るため保持
    try {
      const local = localLoadSync();
      if(local){ localData = local; setData(migrate(local)); setLoading(false); shownLocal = true; }
    } catch(e) {}

    // ② Firebase(遅延ロード)の準備ができ次第、Firestoreから最新を取得して上書き＋同期開始
    whenFirebaseReady(()=>{
    cloudLoad().then(async d=>{
      const migrated = migrate(d);
      // ★ 起動時もローカルのお手伝い項目(タスク定義)を保護＝Firestoreが古くても項目が消えない(ユニオン)
      if(localData){
        try{
          const lm = migrate(localData);
          const _uni=(a,b)=>{const m={};[...(a||[]),...(b||[])].forEach(t=>{if(t&&t.id!=null)m[t.id]=t;});return Object.values(m);};
          if(lm.goodTasks) migrated.goodTasks=_uni(migrated.goodTasks, lm.goodTasks);
          if(lm.badTasks)  migrated.badTasks =_uni(migrated.badTasks,  lm.badTasks);
          if(lm.myTaskIds) migrated.myTaskIds={...(migrated.myTaskIds||{}),...lm.myTaskIds};
          if(lm.dailyTaskSets&&lm.dailyTaskSets.length>(migrated.dailyTaskSets||[]).length) migrated.dailyTaskSets=lm.dailyTaskSets;
          if(lm.dailyTasks&&lm.dailyTasks.length>(migrated.dailyTasks||[]).length) migrated.dailyTasks=lm.dailyTasks;
        }catch(e){}
      }
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
        }
      }
      setData(migrated);
      if(!shownLocal) setLoading(false);
      startSync();
    }).catch(()=>{
      // Firestore失敗時：ローカル未表示のときだけINITで起動（ローカル表示済みなら維持）
      if(!shownLocal){ setData({...INIT}); setLoading(false); }
    });
    });
    // クリーンアップ：アンマウント時にポーリング・リスナー停止（Strict Mode二重マウント対策）
    return ()=>{
      if(pollRef.current){ clearInterval(pollRef.current); pollRef.current=null; }
      try{ if(_unsubscribe){_unsubscribe();_unsubscribe=null;} }catch(e){}
      try{ if(_logsUnsubscribe){_logsUnsubscribe();_logsUnsubscribe=null;} }catch(e){}
    };
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
    if(!next.rewards||next.rewards.length===0) next.rewards=prev.rewards||next.rewards;
    // お手伝い項目は1回の操作で大きく減らない=急減はバグとみなしてロールバック(意図的な1件削除は許容)
    if(!next.goodTasks || next.goodTasks.length < (prev.goodTasks||[]).length-1) next.goodTasks=prev.goodTasks;
    if(!next.badTasks  || next.badTasks.length  < (prev.badTasks||[]).length-1)  next.badTasks=prev.badTasks;
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
            children:d.children.map(c=>c.id===forcePin.id?(({pin,...r})=>({...r,pinh:pinHash(newPin)}))(c):c),
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
        <SetupWizard data={data} update={update} onComplete={(mode)=>{
          if(mode==="join"){
            // 既存ファミリー参加：コード設定済みの状態でフルリロードし、クラウドから正しいデータを取得
            location.reload();
            return;
          }
          // 新規作成：作ったばかりのdataを上書きしないよう、リロードせずに同期だけ開始
          startSync();
          setScreen("home");
        }}/>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    <>
      {/* データ消失の防止ガード（保存失敗・サイズ上限接近を上部に警告） */}
      <SaveGuardBanner/>
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
            if(isChild||isParent) return pinMatches(p, activeChild);
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
        <PinPad title="おや管理画面" emoji="🔐" hint="4けたの暗証番号を入力（初期：0000）" check={p=>parentPinMatches(p, data)}
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
