/* 人工智能训练师 · 理论自测练习 —— 纯前端，无需联网 */
(function () {
  'use strict';

  var PAPERS = (window.QUIZ_DATA && window.QUIZ_DATA.papers) || [];
  var KEY = window.ANSWER_KEY || {};
  var META = window.ANSWER_META || {};
  var EXAM_SECONDS = 90 * 60;
  /* v3 起为单题库模式（pid=T，1445 题），与旧 A/B/C 进度的 key 不兼容，
     存储升为 aitp.v2 独立起存；旧进度仍保留在 localStorage 的 aitp.v1 中，不自动删除 */
  var LS = 'aitp.v2';

  var ALL = [];
  var BY_ID = {};
  var QMAP = {};
  var NMAP = {};   /* 全局题号 -> 题目（题库全局编号，单选→多选→判断顺序） */
  var MAXN = 0;
  var TYPES = ['single', 'multi', 'judge'];
  PAPERS.forEach(function (p) {
    BY_ID[p.id] = p;
    p.questions.forEach(function (q) {
      q.pid = p.id;
      q.key = p.id + '#' + q.n;
      ALL.push(q);
      QMAP[q.key] = q;
      if (!NMAP[q.n]) NMAP[q.n] = q;
      if (q.n > MAXN) MAXN = q.n;
    });
  });

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function byPaperNo(a, b) {
    if (a.pid !== b.pid) return a.pid < b.pid ? -1 : 1;
    return a.n - b.n;
  }
  function typeLabel(t) { return t === 'multi' ? '多选题' : (t === 'judge' ? '判断题' : '单选题'); }

  /* ---------------- storage ---------------- */
  function readDB() {
    var d = null;
    try { d = JSON.parse(window.localStorage.getItem(LS) || 'null'); } catch (e) { d = null; }
    if (!d || typeof d !== 'object') d = {};
    d.papers = d.papers || {};
    d.wrong = d.wrong || {};
    d.fav = d.fav || {};
    d.notes = d.notes || {};     /* 逐题笔记：{'T#123': {t:'正文', at, up}}，随备份导出/导入 */
    d.overrides = d.overrides || {};
    d.history = d.history || [];
    d.settings = d.settings || {};
    return d;
  }
  var db = readDB();
  var memOnly = false;
  function save() {
    if (memOnly) return;
    try { window.localStorage.setItem(LS, JSON.stringify(db)); }
    catch (e) {
      /* 存储空间不足：逐条丢弃最旧的学习记录（大快照占空间）后重试，避免整个进度静默失效 */
      for (var i = 0; i < 50 && db.history.length; i++) {
        db.history.shift();
        try {
          window.localStorage.setItem(LS, JSON.stringify(db));
          toast('存储空间不足，已自动清理 ' + (i + 1) + ' 条最旧的学习记录');
          return;
        } catch (e2) {}
      }
      memOnly = true;
      toast('浏览器存储空间不足，本次进度可能无法保存，请导出学习记录备份');
    }
  }
  function pstate(pid) {
    var s = db.papers[pid];
    if (!s) {
      s = { answers: {}, flags: {}, sessions: {} };
      db.papers[pid] = s;
    }
    if (!s.sessions) {
      // v1 -> v2 迁移：原来的整卷状态变成 sessions.all
      var sessions = {};
      if (s.order || s.mode || (s.answers && Object.keys(s.answers).length)) {
        sessions.all = {
          idx: s.idx || 0, mode: s.mode || 'practice', order: s.order || null,
          random: !!s.random, done: !!s.done, score: (s.score == null ? null : s.score),
          total: s.total || 0, used: s.used || 0, deadline: s.deadline || 0, at: 0
        };
      }
      s.sessions = sessions;
      delete s.idx; delete s.mode; delete s.done; delete s.score; delete s.used;
      delete s.deadline; delete s.types; delete s.random; delete s.order; delete s.total;
    }
    return s;
  }

  function modState(pid, mod) {
    var s = pstate(pid);
    var ms = s.sessions[mod];
    if (!ms) {
      ms = { idx: 0, mode: '', order: null, random: false, done: false, score: null,
             total: 0, used: 0, deadline: 0, at: 0 };
      s.sessions[mod] = ms;
    }
    return ms;
  }

  function moduleQuestions(p, mod) {
    if (mod === 'all') return p.questions.slice();
    if (mod === 'mock' || mod === 'random') {
      /* 模拟考试 / 全库随机：题目列表存在模块会话的 order 里 */
      var mstate = pstate(p.id).sessions[mod];
      return (mstate && mstate.order) ? mstate.order.map(function (k) { return QMAP[k]; }).filter(Boolean) : [];
    }
    return p.questions.filter(function (q) { return q.t === mod; });
  }

  function modLabel(mod) {
    if (mod === 'mock') return '模拟考试';
    if (mod === 'random') return '全库随机';
    return mod === 'all' ? '整套模拟' : typeLabel(mod);
  }

  function examLimit(n) {
    return Math.max(300, Math.round(EXAM_SECONDS * n / 100));
  }

  /* 清空某模块（按题型）已答答案与标记，并重置该模块会话 */
  function clearModuleAnswers(p, mod) {
    var st = pstate(p.id);
    moduleQuestions(p, mod).forEach(function (q) {
      delete st.answers[q.key];
      delete st.flags[q.key];
    });
    if (st.sessions[mod]) {
      var ms = st.sessions[mod];
      ms.order = null; ms.idx = 0; ms.done = false; ms.score = null; ms.total = 0;
      ms.used = 0; ms.deadline = 0; ms.random = false; ms.at = 0;
    }
    save();
  }

  /* 清空整卷已答答案与标记，并重置全部模块会话 */
  function clearPaperAnswers(pid) {
    var st = pstate(pid);
    Object.keys(st.answers).forEach(function (k) { delete st.answers[k]; });
    Object.keys(st.flags).forEach(function (k) { delete st.flags[k]; });
    Object.keys(st.sessions).forEach(function (m) {
      var ms = st.sessions[m];
      ms.order = null; ms.idx = 0; ms.done = false; ms.score = null; ms.total = 0;
      ms.used = 0; ms.deadline = 0; ms.random = false; ms.at = 0;
    });
    save();
  }

  /* 重做某模块：确认后清空本模块已答再重新开始 */
  function redoModule(pid, mod, mode, random) {
    var p = BY_ID[pid];
    showModal('重做本模块？', '将清空「' + modLabel(mod) + '」的已答答案与标记（错题本、收藏、历史成绩保留），然后重新开始。', '重做', function () {
      clearModuleAnswers(p, mod);
      beginSession(pid, mod, mode, { fresh: true, random: !!random });
    }, '取消');
  }

  function moduleAnswered(pid, mod) {
    var p = BY_ID[pid], s = db.papers[pid];
    if (!p || !s) return 0;
    var n = 0;
    moduleQuestions(p, mod).forEach(function (q) { if (s.answers[q.key]) n++; });
    return n;
  }

  /* ---------------- utils ---------------- */
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function cloneTpl(id) {
    return document.getElementById(id).content.firstElementChild.cloneNode(true);
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1900);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return pad2(m) + ':' + pad2(s);
  }
  function fmtUsed(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? m + ' 分 ' + s + ' 秒' : s + ' 秒';
  }
  function letterAt(i) { return 'ABCDEFGH'.charAt(i); }
  function sortedLetters(str) {
    return (str || '').toUpperCase().split('').filter(function (c, i, a) { return 'ABCDEFGH'.indexOf(c) >= 0 && a.indexOf(c) === i; }).sort().join('');
  }
  function correctOf(q) {
    var ov = db.overrides[q.pid];
    if (ov && ov[q.n]) return sortedLetters(ov[q.n]);
    var k = KEY[q.pid];
    return k && k[q.n] ? sortedLetters(k[q.n]) : '';
  }
  function typeName(t) { return t === 'multi' ? '多选题' : (t === 'judge' ? '判断题' : '单选题'); }
  function typeTagClass(t) { return t === 'multi' ? 'tag multi' : (t === 'judge' ? 'tag judge' : 'tag'); }

  /* ---------------- modal ---------------- */
  function showModal(title, text, okText, onOk, cancelText, onCancel, extra) {
    var m = cloneTpl('tpl-modal');
    $('.modal h3', m).textContent = title;
    $('.modal p', m).textContent = text;
    var okBtn = $('.modal .btn-primary', m);
    var cancelBtn = $('.modal .btn:not(.btn-primary)', m);
    okBtn.textContent = okText || '确定';
    cancelBtn.textContent = cancelText || '取消';
    if (extra && extra.text) {
      var eb = el('button', 'btn', extra.text);
      eb.setAttribute('data-act', 'modal-extra');
      okBtn.parentNode.insertBefore(eb, okBtn);
    }
    var root = document.getElementById('modalRoot');
    root.appendChild(m);
    function close() { if (m.parentNode) m.parentNode.removeChild(m); }
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) { if (e.target === m) close(); return; }
      var act = b.getAttribute('data-act');
      if (act === 'modal-ok') { close(); if (onOk) onOk(); }
      else if (act === 'modal-extra') { close(); if (extra && extra.onClick) extra.onClick(); }
      else if (act === 'modal-cancel') { close(); if (onCancel) onCancel(); }
    });
    return close;
  }

  /* ---------------- state ---------------- */
  var route = 'home';
  var pick = { pid: null, mode: 'exam' };
  var sess = null;
  /* v3.11.1 交卷弹窗跳转回调：viewQuiz 渲染时注册（rebuildQuestion 是它内部函数，
     confirmSubmit 在外层拿不到，只能走这个模块级引用；离开答题页时置空防悬挂） */
  var quizJump = null;
  var lastResult = null;
  var revOnlyWrong = true;   /* v3.5：默认只回顾错题，正确题按需展开（1445 题全量渲染会卡） */
  var revShown = 60;
  var REV_PAGE = 60;
  var tickTimer = null;
  var reviewH = null;

  /* ---------------- 布局方案：a（主操作区）/ b（左右双栏），经典版已移除 ---------------- */
  var LAYOUTS = ['a', 'b'];
  var LAYOUT_NAME = { a: 'A·主操作区', b: 'B·双栏' };
  var LAYOUT_DESC = {
    a: '布局A：单卷满宽主操作区，主入口全部收进首屏',
    b: '布局B：左侧主训练区 + 右侧工具栏，信息密度更高'
  };
  function layout() {
    var v = db.settings && db.settings.layout;
    return LAYOUTS.indexOf(v) >= 0 ? v : 'a';
  }
  function applyLayoutAttr() {
    document.body.setAttribute('data-layout', layout());
  }
  function cycleLayout() {
    var i = LAYOUTS.indexOf(layout());
    var next = LAYOUTS[(i + 1) % LAYOUTS.length];
    (db.settings || (db.settings = {})).layout = next;
    save();
    applyLayoutAttr();
    render();
    toast('已切换到「' + LAYOUT_NAME[next] + '」布局');
  }

  /* 本设备名称：备份文件携带，恢复时用于标记错题来源 */
  function deviceName() {
    var st = db.settings || (db.settings = {});
    if (!st.deviceName) {
      st.deviceName = '设备-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      save();
    }
    return st.deviceName;
  }

  function cur() { return sess.qs[sess.idx]; }

  /* ---------------- session ---------------- */
  function enterQuiz(pid, mod, mode, st, ms, list) {
    var p = BY_ID[pid];
    sess = {
      pid: pid, mod: mod, title: p.title + ' · ' + modLabel(mod),
      mode: mode, qs: list, answers: st.answers, flags: st.flags,
      idx: Math.min(ms.idx || 0, list.length - 1),
      st: st, ms: ms, persist: true, startAt: Date.now(), pending: {},
      deadline: mode === 'exam' ? ms.deadline : 0, limit: examLimit(list.length),
      random: !!ms.random, done: false
    };
    route = 'quiz';
    render();
  }

  function beginSession(pid, mod, mode, cfg) {
    var p = BY_ID[pid];
    var st = pstate(pid);
    var ms = modState(pid, mod);
    cfg = cfg || {};
    var fresh = cfg.fresh || !ms.order;
    if (fresh) {
      var qs = moduleQuestions(p, mod);
      if (cfg.random) shuffle(qs);
      ms.order = qs.map(function (q) { return q.key; });
      ms.total = qs.length;
      ms.idx = 0;
      ms.done = false;
      ms.score = null;
      ms.used = 0;
      ms.mode = mode;
      ms.random = !!cfg.random;
      ms.deadline = mode === 'exam' ? Date.now() + examLimit(qs.length) * 1000 : 0;
      ms.at = Date.now();
    } else {
      if (!ms.total) ms.total = ms.order.length;
      ms.mode = mode;
      if (mode !== 'exam') {
        ms.deadline = 0;
      } else if (!ms.deadline) {
        ms.deadline = Date.now() + examLimit(ms.total) * 1000;
      } else if (ms.deadline < Date.now()) {
        // 考试超时续做：弹窗选择，不再进入后立即自动交卷
        showModal('上次考试已超时', '作答已保存，但考试时间已过。可「重新计时继续」（保留已答，重新给足考试时长），或「重做本卷」（清空本模块已答后重新开始）。',
          '重新计时继续', function () {
            ms.deadline = Date.now() + examLimit(ms.total || ms.order.length) * 1000;
            ms.mode = mode;
            var list = ms.order.map(function (k) { return QMAP[k]; }).filter(Boolean);
            enterQuiz(pid, mod, mode, st, ms, list);
          }, '重做本卷', function () {
            clearModuleAnswers(p, mod);
            beginSession(pid, mod, mode, { fresh: true, random: cfg.random });
          });
        return;
      }
    }
    var list = ms.order.map(function (k) { return QMAP[k]; }).filter(Boolean);
    if (!list.length) {
      list = moduleQuestions(p, mod);
      ms.order = list.map(function (q) { return q.key; });
      ms.total = list.length;
    }
    enterQuiz(pid, mod, mode, st, ms, list);
  }

  function beginSet(qs, title, mode, random, persistOpt, tempKey) {
    if (random) shuffle(qs);
    sess = {
      pid: null, mod: null, title: title, mode: mode, qs: qs,
      answers: {}, flags: {}, idx: 0, st: null, ms: null,
      persist: !!persistOpt, tempKey: tempKey || null, startAt: Date.now(), pending: {},
      deadline: mode === 'exam' ? Date.now() + Math.max(600, qs.length * 54) * 1000 : 0,
      limit: Math.max(600, qs.length * 54), done: false,
      random: !!random
    };
    if (tempKey) { db.temp = null; save(); }  /* 新题组替换旧断点 */
    route = 'quiz';
    render();
  }

  function applyOrder(randomize) {
    if (!sess) return;
    var head = sess.qs.slice(0, sess.idx + 1);
    var tail = sess.qs.slice(sess.idx + 1);
    if (randomize) shuffle(tail); else tail.sort(byPaperNo);
    sess.qs = head.concat(tail);
    sess.random = randomize;
    if (sess.persist && sess.ms) {
      sess.ms.order = sess.qs.map(function (q) { return q.key; });
      sess.ms.random = randomize;
      save();
    }
    render();
    toast(randomize ? '已切换：后面的题随机出' : '已切换：后面的题按顺序出');
  }

  function openPaper(pid, mode) {
    pick.pid = pid;
    pick.mode = mode || 'exam';
    route = 'paper';
    render();
  }

  function remainingSec() {
    if (!sess || !sess.deadline) return 0;
    return Math.max(0, Math.ceil((sess.deadline - Date.now()) / 1000));
  }
  function usedSec() {
    if (!sess) return 0;
    if (sess.mode === 'exam' && sess.deadline) return Math.min(sess.limit || EXAM_SECONDS, (sess.limit || EXAM_SECONDS) - remainingSec());
    return (Date.now() - sess.startAt) / 1000;
  }

  function persistPos() {
    if (sess && sess.flushNote) { try { sess.flushNote(); } catch (e) {} }  /* 笔记兜底落库 */
    if (sess && sess.persist && sess.ms) { sess.ms.idx = sess.idx; sess.ms.at = Date.now(); save(); }
    if (sess && sess.tempKey) {
      /* 临时题组（全库随机/自定义题库）断点：存到 db.temp，首页可继续 */
      db.temp = {
        key: sess.tempKey, title: sess.title, mode: sess.mode,
        order: sess.qs.map(function (q) { return q.key; }), idx: sess.idx,
        answers: sess.answers, flags: sess.flags, deadline: sess.deadline || 0,
        random: !!sess.random, at: Date.now()
      };
      save();
    }
  }

  /* 恢复临时题组（全库随机/自定义题库）的断点 */
  function resumeTemp() {
    var t = db.temp;
    if (!t || !t.order || !t.order.length) { toast('没有可恢复的练习'); return; }
    var qs = t.order.map(function (k) { return QMAP[k]; }).filter(Boolean);
    if (!qs.length) { db.temp = null; save(); toast('题目已失效，请重新开始'); return; }
    sess = {
      pid: null, mod: null, title: t.title, mode: t.mode || 'practice', qs: qs,
      answers: t.answers || {}, flags: t.flags || {},
      idx: Math.min(t.idx || 0, qs.length - 1), st: null, ms: null,
      persist: true, tempKey: t.key, startAt: Date.now(), pending: {},
      deadline: t.deadline || 0, limit: examLimit(qs.length), done: false, random: !!t.random
    };
    route = 'quiz';
    render();
    toast('已恢复上次进度');
  }

  /* ---------------- scoring ---------------- */
  function evaluate(s) {
    var stat = { single: [0, 0], multi: [0, 0], judge: [0, 0] };
    var score = 0, unknown = 0, blank = 0, wrong = [];
    s.qs.forEach(function (q) {
      var c = correctOf(q), a = s.answers[q.key] || '';
      stat[q.t][1]++;
      if (!c) { unknown++; return; }
      if (a === c) { score++; stat[q.t][0]++; }
      else { if (!a) blank++; else wrong.push(q); }
    });
    return { score: score, stat: stat, unknown: unknown, blank: blank, wrong: wrong, total: s.qs.length };
  }

  function addWrong(q) {
    if (!db.wrong[q.key]) { db.wrong[q.key] = { pid: q.pid, n: q.n, at: Date.now() }; save(); }
  }
  function removeWrong(q) {
    if (db.wrong[q.key]) { delete db.wrong[q.key]; save(); }
  }

  /* ---------------- notes ----------------
     逐题笔记：key 与错题本/收藏同一套（T#n），所以不论是整套、题型模块、
     错题重练、收藏重练、全库随机还是模拟考试，做到同一道题都能看到同一份笔记。
     结构：{'T#n': {pid, n, t:'整题笔记', o:{'A':'该选项的一句备注'}, at, up}} */
  function noteOf(q) {
    var n = db.notes[q.key];
    return (n && n.t) ? n : null;
  }
  /* 选项备注：{'A':'…'}，按选项字母存 */
  function optNotesOf(q) {
    var n = db.notes[q.key];
    return (n && n.o) ? n.o : {};
  }
  function optNoteOf(q, L) {
    var o = optNotesOf(q);
    return o[L] || '';
  }
  /* 有整题笔记或任意选项备注，都算「这道题写过笔记」 */
  function noteHasContent(n) {
    if (!n) return false;
    if (n.t) return true;
    return !!(n.o && Object.keys(n.o).length);
  }
  function noteCount() {
    return Object.keys(db.notes).filter(function (k) { return noteHasContent(db.notes[k]); }).length;
  }
  /* 空文本等于删除笔记；返回 true 表示有内容落库 */
  function setNote(q, text) {
    var t = String(text == null ? '' : text).replace(/\s+$/, '');
    var old = db.notes[q.key];
    if (!t.trim()) {
      if (!old) return false;
      /* 只清整题笔记，选项备注保留；两者都空才删除整条 */
      delete old.t;
      old.up = Date.now();
      if (!noteHasContent(old)) { delete db.notes[q.key]; save(); return false; }
      db.notes[q.key] = old; save();
      return false;
    }
    if (old && old.t === t) return true;   /* 内容没变：不重复写盘（翻题时每次都会 flush） */
    var rec = old || { pid: q.pid, n: q.n, at: Date.now() };
    rec.pid = q.pid; rec.n = q.n; rec.t = t; rec.up = Date.now();
    if (!rec.at) rec.at = rec.up;
    db.notes[q.key] = rec;
    save();
    return true;
  }
  /* 选项备注：空文本＝删掉该选项的备注 */
  function setOptNote(q, L, text) {
    var t = String(text == null ? '' : text).replace(/\s+$/, '');
    var rec = db.notes[q.key];
    if (!t.trim()) {
      if (!rec || !rec.o || !rec.o[L]) return false;
      delete rec.o[L];
      if (!Object.keys(rec.o).length) delete rec.o;
      rec.up = Date.now();
      if (!noteHasContent(rec)) { delete db.notes[q.key]; save(); return false; }
      db.notes[q.key] = rec; save();
      return false;
    }
    rec = rec || { pid: q.pid, n: q.n, at: Date.now() };
    rec.pid = q.pid; rec.n = q.n;
    rec.o = rec.o || {};
    if (rec.o[L] === t) return true;
    rec.o[L] = t;
    rec.up = Date.now();
    if (!rec.at) rec.at = rec.up;
    db.notes[q.key] = rec;
    save();
    return true;
  }

  /* 某次练习记录中答错的题（key 数组）；基于答题快照与当前答案计算 */
  function wrongKeysOf(h) {
    if (!h || !h.snap) return [];
    var out = [];
    Object.keys(h.snap).forEach(function (k) {
      var q = QMAP[k];
      var c = q ? correctOf(q) : null;
      if (c && h.snap[k] !== c) out.push(k);
    });
    return out;
  }

  /* ---------------- timer ---------------- */
  function tick() {
    if (route !== 'quiz' || !sess) return;
    var t = document.getElementById('timerText');
    if (!t) return;
    var exam = sess.mode === 'exam';
    var sec = exam ? remainingSec() : (Date.now() - sess.startAt) / 1000;
    t.textContent = fmtClock(sec);
    var box = document.getElementById('timer');
    if (box) box.classList.toggle('warn', exam && sec <= 300);
    if (exam && sess.deadline && sec <= 0 && !sess.done) {
      sess.done = true;
      evaluateAndFinish(true);
    }
  }

  /* ---------------- render root ---------------- */
  function render() {
    var node;
    if (route === 'home') node = viewHome();
    else if (route === 'quiz') node = viewQuiz();
    else if (route === 'result') node = viewResult();
    else if (route === 'wrong') node = viewList('wrong');
    else if (route === 'fav') node = viewList('fav');
    else if (route === 'notes') node = viewNotes();
    else if (route === 'review') node = viewReview();
    else if (route === 'history') node = viewHistory();
    else if (route === 'stats') node = viewStats();
    else if (route === 'paper') node = viewPaper();
    else node = viewKey();

    app.innerHTML = '';
    app.appendChild(node);
    window.scrollTo(0, 0);
    paintNav();
    clearInterval(tickTimer);
    if (route === 'quiz') {
      tickTimer = setInterval(tick, 1000);
      tick();
    }
  }

  function paintNav() {
    $all('.top-link').forEach(function (b) {
      var nav = b.getAttribute('data-nav');
      b.classList.toggle('active', nav === route || (route === 'result' && nav === 'home') || (route === 'review' && nav === 'wrong'));
    });
    var wc = Object.keys(db.wrong).length;
    document.getElementById('navWrong').textContent = wc ? '(' + wc + ')' : '';
    var nc = noteCount();
    var nn = document.getElementById('navNotes');
    if (nn) nn.textContent = nc ? '(' + nc + ')' : '';
  }

  /* ---------------- home ---------------- */
  /* 单卷概览：已答 / 最高分 / 分题型进度 / 可继续的会话 */
  function paperStats(p) {
    var s = db.papers[p.id] ? pstate(p.id) : null;
    var byType = {
      single: { done: 0, total: 0 },
      multi: { done: 0, total: 0 },
      judge: { done: 0, total: 0 }
    };
    p.questions.forEach(function (q) {
      byType[q.t].total++;
      if (s && s.answers[q.key]) byType[q.t].done++;
    });
    var done = s ? Object.keys(s.answers).length : 0;
    var best = null;
    db.history.forEach(function (h) {
      if (h.pid === p.id && (!h.mod || h.mod === 'all') && (h.total || 100) === 100 && (best === null || h.score > best)) best = h.score;
    });
    var recent = null, recentMod = null;
    if (s && s.sessions) {
      Object.keys(s.sessions).forEach(function (mod) {
        var ms = s.sessions[mod];
        if (!ms || ms.done || !ms.order) return;
        if (!moduleAnswered(p.id, mod)) return;
        if (!recent || (ms.at || 0) > (recent.at || 0)) { recent = ms; recentMod = mod; }
      });
    }
    return {
      p: p, done: done, total: p.questions.length, best: best,
      byType: byType, recent: recent, recentMod: recentMod
    };
  }

  /* v3.9.2 清空前自动备份：页内回滚点（可一键反悔）+ 备份文件下载 */
  function makeClearUndo(p) {
    var st = pstate(p.id);
    db.clearUndo = {
      pid: p.id, title: p.title, at: Date.now(),
      answered: Object.keys(st.answers).length,
      state: JSON.parse(JSON.stringify(st))   /* 深拷贝整卷状态：答案 / 标记 / 各模块会话进度 */
    };
  }
  function restoreClearUndo() {
    var u = db.clearUndo;
    if (!u || !u.pid) return;
    showModal('恢复清空前的作答？',
      '将把「' + u.title + '」恢复到清空前的状态（已答 ' + (u.answered || 0) + ' 题）。注意：清空之后新做的作答会被覆盖。',
      '恢复', function () {
        db.papers[u.pid] = u.state;
        delete db.clearUndo;
        save(); render();
        toast('已恢复清空前的作答（' + (u.answered || 0) + ' 题）');
      }, '取消');
  }
  function discardClearUndo() {
    showModal('丢弃回滚点？', '丢弃后「' + (db.clearUndo ? db.clearUndo.title : '') + '」清空前的作答将无法再恢复。想留一份到电脑的话，先点「备份到本地」再丢弃。',
      '丢弃', function () {
        delete db.clearUndo;
        save(); render();
        toast('已丢弃回滚点');
      }, '取消');
  }
  /* 回滚条上的「备份到本地」：把清空前的那份状态导成 JSON 文件（唯一手动下载点） */
  function exportClearUndo() {
    var u = db.clearUndo;
    if (!u || !u.pid) return;
    var snap = JSON.parse(JSON.stringify(db));
    snap.papers = snap.papers || {};
    snap.papers[u.pid] = u.state;   /* 用清空前的快照覆盖，导出的就是清空前的进度 */
    delete snap.clearUndo;
    var d = new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
    downloadBlob(JSON.stringify({ backupVer: 2, deviceName: deviceName(), exportedAt: Date.now(), db: snap }, null, 2),
      'application/json', '清空前进度备份_' + stamp + '.json');
    toast('已把清空前的进度备份到本地（含全部错题、收藏、笔记）');
  }
  function buildClearUndo() {
    var u = db.clearUndo;
    if (!u || !u.pid) return null;
    var bar = el('div', 'clear-undo');
    var d = new Date(u.at);
    bar.appendChild(el('span', 'cu-text',
      '↩ 已清空「' + u.title + '」（此前已答 ' + (u.answered || 0) + ' 题，' +
      pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + '），反悔可一键恢复'));
    var rb = el('button', 'btn btn-primary cu-btn', '恢复作答');
    rb.addEventListener('click', restoreClearUndo);
    bar.appendChild(rb);
    var eb = el('button', 'btn cu-btn', '备份到本地');
    eb.title = '把清空前的进度导出成 JSON 文件，可换设备恢复';
    eb.addEventListener('click', exportClearUndo);
    bar.appendChild(eb);
    var dbtn = el('button', 'btn cu-btn', '丢弃');
    dbtn.addEventListener('click', discardClearUndo);
    bar.appendChild(dbtn);
    return bar;
  }

  /* 整卷开始；已有作答时弹「继续做 / 清空并开始 / 取消」 */
  function startPaperAll(p, mode) {
    var st = pstate(p.id);
    if (Object.keys(st.answers).length === 0) {
      beginSession(p.id, 'all', mode, { fresh: true, random: false });
      return;
    }
    showModal('本卷已有作答记录', '可以「继续做」保留本卷已答接着做，或「清空并开始」清空本卷全部已答答案与标记后重新做（错题本、收藏、笔记、历史成绩保留）。',
      '清空并开始', function () {
        /* 二次确认：清空前在本浏览器保存回滚点，反悔可恢复（不下载文件） */
        showModal('确认清空并重新开始？',
          '清空前会把本卷当前的作答与进度保存在本浏览器里（一个可一键恢复的「回滚点」），' +
          '不会下载任何文件到电脑。然后才清空本卷全部已答答案与标记（错题本、收藏、笔记、历史成绩保留）。' +
          '清空后反悔了，回到首页点「恢复作答」即可原样还原。',
          '确认清空', function () {
            makeClearUndo(p);   /* 先拍快照（此时答案还未清） */
            clearPaperAnswers(p.id);
            beginSession(p.id, 'all', mode, { fresh: true, random: false });
            toast('已保存回滚点并清空，反悔可回首页恢复');
          }, '取消');
      }, '取消', null,
      { text: '继续做', onClick: function () {
          var ms = st.sessions.all;
          if (ms && ms.order && !ms.done) beginSession(p.id, 'all', mode, {});
          else beginSession(p.id, 'all', mode, { fresh: true, random: false });
        } });
  }

  /* 模拟考试：随机 60 单选 + 10 多选 + 30 判断，限时 90 分钟（临时会话，独立答案） */
  function newMockExam() {
    var qs = pickMock().map(function (q) {
      return { pid: q.pid, n: q.n, key: q.key, t: q.t, q: q.q, o: q.o };
    });
    beginSet(qs, '模拟考试（100 题）', 'exam', false, true, 'mock');
  }
  function startMockExam() {
    var t = db.temp;
    if (t && t.key === 'mock' && t.order && t.order.length && Object.keys(t.answers || {}).length) {
      showModal('模拟考试进行中', '上次模拟还有未交卷的作答（已答 ' + Object.keys(t.answers).length + ' 题）。可「继续做」接着考（计时按剩余时间），或「重新抽题」开始新的一次模拟。',
        '继续做', function () { resumeTemp(); }, '取消', null,
        { text: '重新抽题', onClick: newMockExam });
      return;
    }
    newMockExam();
  }

  /* 自定义题库训练：题号/范围用「、」分隔，组卷后练习 */
  function startCustomSet(raw) {
    var nos = parseCustomNos(raw, MAXN);
    if (!nos.length) { toast('请输入有效题号，如：1-50、850、1081'); return; }
    var qs = nos.map(function (n) { return NMAP[n]; }).filter(Boolean);
    beginSet(qs, '自定义题库（' + qs.length + ' 题）', 'practice', false, true, 'custom');
    toast('已组卷 ' + qs.length + ' 题，开始训练');
  }

  function makeMiniCard(icon, cls, title, sub, fn) {
    var c = el('div', 'mini-card');
    c.appendChild(el('div', 'ico ' + cls, icon));
    var box = el('div');
    box.appendChild(el('h4', null, title));
    box.appendChild(el('p', null, sub));
    c.appendChild(box);
    c.addEventListener('click', fn);
    return c;
  }

  /* 工具卡：四张。A 布局横排一行，B 布局竖排右栏 */
  function buildToolCards() {
    var wrap = el('div', 'tool-cards');
    wrap.appendChild(makeMiniCard('📕', 'warn', '错题重练', '已收录 ' + Object.keys(db.wrong).length + ' 道错题', function () {
      route = 'wrong'; render();
    }));
    wrap.appendChild(makeMiniCard('⭐', 'ok', '我的收藏', '已收藏 ' + Object.keys(db.fav).length + ' 道题', function () {
      route = 'fav'; render();
    }));
    wrap.appendChild(makeMiniCard('📝', '', '我的笔记', '已记 ' + noteCount() + ' 道题', function () {
      route = 'notes'; render();
    }));
    wrap.appendChild(makeMiniCard('📊', 'ok', '正确率统计', '按题型 / 知识点看正确率', function () {
      route = 'stats'; render();
    }));
    wrap.appendChild(makeMiniCard('🗂️', '', '学习记录', '已保存 ' + db.history.length + ' 次作答', function () {
      route = 'history'; render();
    }));
    return wrap;
  }

  function buildKpis() {
    var kpis = el('div', 'kpis');
    var answered = 0;
    PAPERS.forEach(function (p) {
      var s = db.papers[p.id];
      if (s) answered += Object.keys(s.answers).length;
    });
    var avg = null;
    if (db.history.length) {
      var sum = 0, cnt = 0;
      db.history.forEach(function (h) { sum += h.score / (h.total || 100) * 100; cnt++; });
      avg = Math.round(sum / cnt);
    }
    [['题库总量', ALL.length + ' 题'], ['累计作答', answered + ' 题'],
     ['历史平均分', avg === null ? '—' : avg], ['错题数量', Object.keys(db.wrong).length + ' 题']].forEach(function (x) {
      var k = cloneTpl('tpl-kpi');
      $('span', k).textContent = x[0];
      $('b', k).textContent = x[1];
      kpis.appendChild(k);
    });
    return kpis;
  }

  /* 新版主操作卡：题量分布 / 按题型进度 / 竖排主按钮 */
  function buildMainCard(p) {
    var st = paperStats(p);
    var card = el('article', 'main-card');

    var left = el('div', 'mc-left');
    left.appendChild(el('h3', null, '官方题库'));
    left.appendChild(el('p', 'mc-meta', st.total + ' 题 · 满分 100 · 含知识点与解析'));
    var chips = el('div', 'mc-types');
    [['single', '单选'], ['multi', '多选'], ['judge', '判断']].forEach(function (t) {
      var c = el('span', 'mc-chip');
      c.appendChild(el('b', null, String(st.byType[t[0]].total)));
      c.appendChild(el('i', null, t[1]));
      chips.appendChild(c);
    });
    left.appendChild(chips);

    var mid = el('div', 'mc-mid');
    var midHead = el('p', 'mc-label', '按题型进度');
    midHead.appendChild(el('span', 'mc-pct', st.done + ' / ' + st.total));
    mid.appendChild(midHead);
    ['single', 'multi', 'judge'].forEach(function (t) {
      var bt = st.byType[t];
      if (!bt.total) return;
      var row = el('div', 'pbar-row');
      row.appendChild(el('span', 'pbar-name', typeName(t)));
      var track = el('span', 'pbar-track');
      var fill = el('i');
      fill.style.width = (bt.total ? Math.round(bt.done / bt.total * 100) : 0) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'pbar-num', bt.done + '/' + bt.total));
      mid.appendChild(row);
    });

    var right = el('div', 'mc-right');
    var bExam = el('button', 'btn btn-primary', '开始考试');
    bExam.setAttribute('data-act', 'card-exam');
    bExam.addEventListener('click', function () { startPaperAll(p, 'exam'); });
    right.appendChild(bExam);
    var bPrac = el('button', 'btn', '练习模式');
    bPrac.setAttribute('data-act', 'card-practice');
    bPrac.addEventListener('click', function () { startPaperAll(p, 'practice'); });
    right.appendChild(bPrac);
    var bMock = el('button', 'btn', '模拟考试');
    bMock.title = '随机 60 单选 + 10 多选 + 30 判断，限时 90 分钟';
    bMock.setAttribute('data-act', 'card-mock');
    bMock.addEventListener('click', function () { startMockExam(); });
    right.appendChild(bMock);

    card.appendChild(left);
    card.appendChild(mid);
    card.appendChild(right);

    var foot = el('div', 'mc-foot');
    if (st.best !== null) foot.appendChild(el('span', 'mc-best', '最高分 ' + st.best));
    var rnd = el('button', 'btn btn-sm btn-ghost', '🎲 全库随机');
    rnd.setAttribute('data-act', 'random-exam');
    rnd.addEventListener('click', function () { startRandomExam(); });
    foot.appendChild(rnd);
    if (st.recent) {
      var r = el('button', 'btn btn-sm btn-ghost mc-resume',
        '⏵ 继续：' + modLabel(st.recentMod) + ' · ' + (st.recent.mode === 'practice' ? '练习' : '考试') +
        ' · ' + (st.recent.random ? '随机' : '顺序') + ' · ' + moduleAnswered(p.id, st.recentMod) + '/' + (st.recent.total || 0));
      r.addEventListener('click', function () { beginSession(p.id, st.recentMod, st.recent.mode || 'exam', {}); });
      foot.appendChild(r);
    }
    var mods = el('button', 'btn btn-sm btn-ghost', '按题型练习 →');
    mods.setAttribute('data-act', 'card-modules');
    mods.addEventListener('click', function () { openPaper(p.id, pick.mode); });
    foot.appendChild(mods);
    card.appendChild(foot);

    return card;
  }

  function buildCustomBox() {
    var box = el('div', 'panel custom-panel compact');
    var head = el('div', 'cp-head');
    head.appendChild(el('h3', null, '自定义组卷'));
    head.appendChild(el('span', 'cp-sub', '题号或范围，用「、」分隔'));
    box.appendChild(head);
    var row = el('div', 'custom-row');
    var inp = el('input');
    inp.id = 'customNos';
    inp.spellcheck = false;
    inp.placeholder = '例如：1-50、120、850-860、1081';
    row.appendChild(inp);
    var btn = el('button', 'btn btn-primary', '开始训练');
    btn.setAttribute('data-act', 'custom-start');
    btn.addEventListener('click', function () { startCustomSet(inp.value); });
    row.appendChild(btn);
    box.appendChild(row);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); startCustomSet(inp.value); }
    });
    box.appendChild(el('p', 'desc', '题号即全局编号：单选 1-849、多选 850-1080、判断 1081-1445，无效题号自动忽略。'));
    return box;
  }

  /* 断点续做条（全库随机 / 自定义 / 模拟考中断的练习）
     v3.11.4：不再要求「已答 > 0」——只写了笔记、只翻了题的断点也要能续上，
     否则刷新后回来只能重开，笔记虽然还在但题都找不到（用户实际踩到过）。 */
  function buildTempResume() {
    if (!(db.temp && db.temp.order && db.temp.order.length)) return null;
    var doneN = Object.keys(db.temp.answers || {}).length;
    var atN = Math.min((db.temp.idx || 0) + 1, db.temp.order.length);
    var tr = el('button', 'btn temp-resume', '⏵ 继续：' + db.temp.title +
      ' · 第 ' + atN + '/' + db.temp.order.length + ' 题 · 已答 ' + doneN + ' 题');
    tr.addEventListener('click', function () { resumeTemp(); });
    return tr;
  }

  function paintLayoutBtn(node) {
    var b = $('[data-act="layout-cycle"]', node);
    if (!b) return;
    b.textContent = '布局：' + LAYOUT_NAME[layout()];
    b.title = LAYOUT_DESC[layout()] + '（点击切换）';
    b.addEventListener('click', cycleLayout);
  }

  function viewHome() {
    applyLayoutAttr();
    return viewHome2();
  }

  /* ---------- 新版布局（A 单列 / B 双栏，共用 DOM，靠 CSS 分流） ---------- */
  function viewHome2() {
    var node = cloneTpl('tpl-home2');
    var L = layout();
    var p = PAPERS[0];
    var st = paperStats(p);

    var nums = $('#h2Nums', node);
    [['总题量', ALL.length], ['单选', st.byType.single.total], ['多选', st.byType.multi.total], ['判断', st.byType.judge.total]]
      .forEach(function (x) {
        var d = el('div', 'h2-num');
        d.appendChild(el('b', null, String(x[1])));
        d.appendChild(el('span', null, x[0]));
        nums.appendChild(d);
      });

    var note = $('#h2Note', node);
    note.appendChild(el('span', 'h2-note-text',
      '官方题库已收录 ' + ALL.length + ' 题，答案提取自原文【答案】标注；如有更正可在「答案管理」粘贴覆盖。'));
    var more = el('button', 'h2-note-more', '说明');
    more.addEventListener('click', function () {
      showModal('题库说明',
        '本题库为 2026 年广东省人工智能与机器人技能大赛（人工智能训练师赛项）初赛理论题库，共 ' + ALL.length +
        ' 题（单选 ' + st.byType.single.total + ' / 多选 ' + st.byType.multi.total + ' / 判断 ' + st.byType.judge.total +
        '），答案提取自题库原文的【答案】标注，部分题目附知识点与解析。' +
        '若后续有官方更正，可在「答案管理」中粘贴覆盖，所有成绩与错题会按新答案重算。',
        '知道了', null);
    });
    note.appendChild(more);

    var grid = $('#h2Grid', node);
    var main = buildMainCard(p);
    var tools = buildToolCards();
    var custom = buildCustomBox();

    if (L === 'b') {
      var colL = el('div', 'h2-col h2-col-l');
      var colR = el('div', 'h2-col h2-col-r');
      colL.appendChild(main);
      var cuB = buildClearUndo();
      if (cuB) colL.appendChild(cuB);
      var trB = buildTempResume();
      if (trB) colL.appendChild(trB);
      colL.appendChild(buildKpis());
      colR.appendChild(el('h3', 'h2-side-title', '工具与自定义'));
      colR.appendChild(tools);
      colR.appendChild(custom);
      grid.appendChild(colL);
      grid.appendChild(colR);
    } else {
      var s1 = el('div', 'section-title');
      s1.appendChild(el('h2', null, '开始训练'));
      s1.appendChild(el('span', null, '整套训练 / 考试做完全部题，也可按题型专项练'));
      grid.appendChild(s1);
      grid.appendChild(main);
      var cuA = buildClearUndo();
      if (cuA) grid.appendChild(cuA);
      var trA = buildTempResume();
      if (trA) grid.appendChild(trA);

      var s2 = el('div', 'section-title');
      s2.appendChild(el('h2', null, '专项与工具'));
      s2.appendChild(el('span', null, '错题、收藏、统计与学习记录'));
      grid.appendChild(s2);
      grid.appendChild(tools);

      var s3 = el('div', 'section-title');
      s3.appendChild(el('h2', null, '自定义题库训练'));
      s3.appendChild(el('span', null, '输入题号或范围，只练你想练的题'));
      grid.appendChild(s3);
      grid.appendChild(custom);

      var s4 = el('div', 'section-title');
      s4.appendChild(el('h2', null, '学习概况'));
      var sw = el('span', null, '数据保存在本机浏览器 · ');
      var lk = el('a', null, '查看学习记录 →');
      lk.href = 'javascript:;';
      lk.addEventListener('click', function () { route = 'history'; render(); });
      sw.appendChild(lk);
      s4.appendChild(sw);
      grid.appendChild(s4);
      grid.appendChild(buildKpis());
    }

    paintLayoutBtn(node);
    return node;
  }

  /* 解析自定义题号输入："1-50、120、850-860" → 去重排序后的全局题号数组 */
  function parseCustomNos(raw, maxN) {
    var out = {};
    String(raw || '').split(/[、，,;；\s]+/).forEach(function (t) {
      t = t.trim().replace(/^[#＃]/, '');
      if (!t) return;
      var m = t.match(/^(\d+)(?:[-~～—]\s*(\d+))?$/);
      if (!m) return;
      var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      if (b < a) { var x = a; a = b; b = x; }
      if (a < 1) a = 1;
      if (b > maxN) b = maxN;
      for (var n = a; n <= b; n++) out[n] = true;
    });
    return Object.keys(out).map(Number).sort(function (x, y) { return x - y; });
  }

  /* 模拟考试抽题：60 单选 + 10 多选 + 30 判断，按题型顺序拼接 */
  function pickMock() {
    var by = { single: [], multi: [], judge: [] };
    ALL.forEach(function (q) { by[q.t].push(q); });
    shuffle(by.single); shuffle(by.multi); shuffle(by.judge);
    return by.single.slice(0, 60).concat(by.multi.slice(0, 10), by.judge.slice(0, 30));
  }

  function startRandomExam() {
    var t = db.temp;
    if (t && t.key === 'random' && t.order && t.order.length && Object.keys(t.answers || {}).length) {
      showModal('上次全库随机未完成', '检测到中断的全库随机练习（已答 ' + Object.keys(t.answers).length + ' 题）。可「继续做」接着练，或「重新抽题」重新开始。',
        '继续做', function () { resumeTemp(); }, '取消', null,
        { text: '重新抽题', onClick: newRandom });
      return;
    }
    newRandom();
  }

  function newRandom() {
    var picks = shuffle(ALL.slice()).map(function (q) {
      return { pid: q.pid, n: q.n, key: q.key, t: q.t, q: q.q, o: q.o };
    });
    beginSet(picks, '全库随机练习（' + ALL.length + ' 题）', 'practice', false, true, 'random');
  }

  /* ---------------- paper modules ---------------- */
  function viewPaper() {
    var node = cloneTpl('tpl-paper');
    var p = BY_ID[pick.pid];
    var st = pstate(p.id);
    $('#paperTitle', node).textContent = p.title;
    function paintMode() {
      $all('#paperMode button', node).forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-mode') === pick.mode);
      });
    }
    $all('#paperMode button', node).forEach(function (b) {
      b.addEventListener('click', function () { pick.mode = b.getAttribute('data-mode'); paintMode(); });
    });
    paintMode();

    var list = $('#modList', node);
    [['single', '单选题'], ['multi', '多选题'], ['judge', '判断题'], ['all', '整套模拟']].forEach(function (m) {
      var mod = m[0], name = m[1];
      var qs = moduleQuestions(p, mod);
      var ms = st.sessions[mod] || null;
      var answered = moduleAnswered(p.id, mod);
      var card = cloneTpl('tpl-mod-card');
      $('.mod-name', card).textContent = name;
      $('.mod-count', card).textContent = qs.length + ' 题';
      $('.mod-bar i', card).style.width = (qs.length ? Math.round(answered / qs.length * 100) : 0) + '%';
      var running = !!(ms && !ms.done && ms.order && answered > 0);
      var meta = '已答 ' + answered + '/' + qs.length;
      if (ms && ms.done && ms.score != null) meta += ' · 上次 ' + ms.score + '/' + (ms.total || qs.length);
      else if (running) meta += ' · 进行中 · ' + (ms.random ? '随机' : '顺序');
      $('.mod-meta', card).textContent = meta;

      var primary = $('[data-act="mod-start"]', card);
      primary.textContent = running ? '继续' : (ms && ms.done ? '再做一次' : '开始');
      primary.addEventListener('click', function () {
        if (running) {
          beginSession(p.id, mod, pick.mode, {});
        } else if (ms && ms.done) {
          redoModule(p.id, mod, pick.mode, false);
        } else {
          beginSession(p.id, mod, pick.mode, { fresh: true, random: false });
        }
      });
      var redo = $('[data-act="mod-redo"]', card);
      redo.classList.toggle('hidden', !running);
      redo.addEventListener('click', function () {
        redoModule(p.id, mod, pick.mode, false);
      });
      list.appendChild(card);
    });

    $('[data-act="paper-back"]', node).addEventListener('click', function () { route = 'home'; render(); });
    return node;
  }

  /* ---------------- quiz view ---------------- */
  function viewQuiz() {
    var node = cloneTpl('tpl-quiz');
    $('#qTitle', node).textContent = sess.title;
    // 临时题组（全库随机/错题重练等）没有卷别，隐藏分类切换栏
    if (!sess.pid) {
      var jb = $('.jump-bar', node);
      if (jb) jb.classList.add('hidden');
    }
    $('#qModeTag', node).textContent = sess.mode === 'exam' ? '考试模式' : '练习模式';
    var btnOrder = $('#btnOrder', node);
    if (btnOrder) {
      btnOrder.textContent = sess.random ? '随机' : '顺序';
      btnOrder.classList.toggle('on', !!sess.random);
      btnOrder.title = sess.random ? '当前随机出题，点击改为顺序' : '当前按题号顺序，点击改为随机';
      btnOrder.addEventListener('click', function () { applyOrder(!sess.random); });
    }

    var opts = $('#qOpts', node);
    var pbars = $('#pbars', node);

    /* 按题型构建进度条（代替原来的题号格子） */
    var typeTotals = { single: 0, multi: 0, judge: 0 };
    sess.qs.forEach(function (q) { typeTotals[q.t]++; });
    ['single', 'multi', 'judge'].forEach(function (t) {
      if (!typeTotals[t]) return;
      var row = el('div', 'pbar-row');
      row.appendChild(el('span', 'pbar-name', typeName(t)));
      var track = el('span', 'pbar-track');
      var fill = el('i');
      fill.setAttribute('data-type', t);
      track.appendChild(fill);
      row.appendChild(track);
      var num = el('span', 'pbar-num', '0/' + typeTotals[t]);
      num.setAttribute('data-num', t);
      row.appendChild(num);
      pbars.appendChild(row);
    });

    /* ---------- 答题卡：题号格子，点格跳题 ---------- */
    /* 练习模式：答对绿 / 答错红 / 未答白；考试模式交卷前不判分，已答一律蓝（防剧透）。
       标记题琥珀色描边，当前题蓝色描边。 */
    var sheetGrid = $('#sheetGrid', node);
    var sheetChips = [];
    sess.qs.forEach(function (q, i) {
      var chip = el('button', 'sheet-chip', String(q.n));
      chip.type = 'button';
      chip.title = '#' + q.n + ' ' + typeName(q.t);
      chip.addEventListener('click', function () {
        if (sess.idx === i) return;
        sess.idx = i;
        persistPos();
        rebuildQuestion();
        window.scrollTo(0, 0);
        /* 手机端答题卡是抽屉，跳完就收起露出题目 */
        $('#sideCard', node).classList.remove('open');
      });
      sheetGrid.appendChild(chip);
      sheetChips.push(chip);
    });
    if (sess.mode !== 'practice') {
      /* 考试模式交卷前看不到对错：图例里去掉「对/错」两项 */
      var lgOk = sheetGrid.parentNode.querySelector('.lg-ok');
      var lgBad = sheetGrid.parentNode.querySelector('.lg-bad');
      if (lgOk) lgOk.parentNode.removeChild(lgOk);
      if (lgBad) lgBad.parentNode.removeChild(lgBad);
    }

    function rebuildQuestion() {
      noteFlush();       /* 翻题前先把上一题的笔记落库，避免写了没保存就跳走 */
      optNoteFlush();    /* 选项备注同理 */
      var q = cur();
      // 分类切换栏：当前模块高亮
      $all('.jt', node).forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-type') === sess.mod);
      });
      opts.innerHTML = '';
      q.o.forEach(function (txt, i) {
        var L = letterAt(i);
        var o = cloneTpl('tpl-option');
        o.setAttribute('data-letter', L);
        $('.letter', o).textContent = L;
        $('.txt', o).textContent = txt;
        o.addEventListener('click', function () { choose(i); });
        /* 选项后的「✎」：给这个选项单独记一句（手机端由 CSS 隐藏，只展示已有内容） */
        var pen = el('button', 'opt-note-add', '✎');
        pen.type = 'button';
        pen.setAttribute('data-letter', L);
        pen.title = '给这个选项记一句';
        pen.addEventListener('click', function (e) {
          e.stopPropagation();   /* 不要触发选中该选项 */
          toggleOptNote(L);
        });
        o.appendChild(pen);
        opts.appendChild(o);
        /* 选项备注展示/编辑区（紧贴该选项下方） */
        var wrap = el('div', 'opt-note-wrap');
        wrap.setAttribute('data-letter', L);
        opts.appendChild(wrap);
      });
      $('#qNo', node).textContent = '第 ' + (sess.idx + 1) + ' / ' + sess.qs.length + ' 题';
      $('#qGid', node).textContent = '#' + q.n;
      $('#qType', node).textContent = typeName(q.t);
      $('#qType', node).className = typeTagClass(q.t);
      $('#qHint', node).textContent = q.t === 'multi' ? '（多选，全对才得分）' : '';
      $('#qStem', node).textContent = q.q;
      var fav = $('[data-act="fav"]', node);
      fav.textContent = db.fav[q.key] ? '★' : '☆';
      fav.classList.toggle('on', !!db.fav[q.key]);
      paintOptions();
      paintCard();
      paintFeedback();
      paintNote(false);   /* 换题：有笔记自动展开正文，没有则收起 */
      optEditing = null;
      paintOptNotes();    /* 换题：选项备注只展示已有内容 */
      tick();
    }

    /* ---------- 逐题笔记（写、改、自动保存） ---------- */
    var noteTimer = null;
    var noteKey = null;    /* 当前笔记框绑定的题 key，防止慢一拍的保存写串题 */
    var noteRevealed = {}; /* v3.10.3 点过「查看笔记」的题（未作答也看），本会话内保持可见 */

    function noteTime(t) {
      var d = new Date(t || Date.now());
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    /* open：true 强制打开编辑框；false/省略 按「有无笔记 + 是否已作答」决定展示 */
    function paintNote(open) {
      var q = cur(), n = noteOf(q);
      var box = $('#qNote', node), view = $('#noteView', node), ta = $('#noteText', node);
      var badge = $('#noteBadge', node), btn = $('#btnNoteToggle', node);
      var viewBtn = $('#btnNoteView', node);
      if (!box) return;
      /* 同一题重复重绘（如答错后回到原题）时保留正在编辑的内容，不要把用户刚打的字冲掉 */
      var sameEdit = (noteKey === q.key) && box.classList.contains('editing');
      noteKey = q.key;
      /* v3.10.3 防剧透：本题还没作答时，笔记正文不直接亮出来（答题时一眼看到笔记就没得思考了）；
         要看要点下方「查看笔记」主动点开。已作答的题维持自动展示。 */
      var answered = !!sess.answers[q.key];
      var reveal = answered || noteRevealed[q.key] || sameEdit || !!open;
      var oc = Object.keys(optNotesOf(q)).length;   /* 选项备注条数 */
      view.textContent = (n && reveal) ? n.t : '';
      view.classList.toggle('hidden', !n || !reveal);
      box.classList.toggle('has-note', !!n || oc > 0);
      badge.textContent = n ? ('已记 · ' + noteTime(n.up || n.at) + (oc ? ' · 选项备注 ' + oc + ' 条' : ''))
        : (oc ? ('选项备注 ' + oc + ' 条') : '');
      btn.textContent = n ? '编辑' : '写笔记';
      if (viewBtn) viewBtn.classList.toggle('hidden', !(n || oc) || reveal);
      if (!sameEdit) ta.value = n ? n.t : '';
      box.classList.toggle('editing', sameEdit ? true : !!open);
    }

    /* ---------- 选项备注：每个选项后面的 ✎，记这个选项为什么对/错 ---------- */
    var optTimer = null, optPending = null, optEditing = null;

    function scheduleOptSave(key, L, text) {
      optPending = { key: key, L: L, text: text };
      if (optTimer) clearTimeout(optTimer);
      optTimer = setTimeout(function () { optTimer = null; optNoteFlush(); }, 500);
    }
    function optNoteFlush() {
      if (optTimer) { clearTimeout(optTimer); optTimer = null; }
      if (!optPending) return;
      var p = optPending; optPending = null;
      var q2 = QMAP[p.key];
      if (!q2) return;
      setOptNote(q2, p.L, p.text);
      if (q2 === cur()) paintNoteMeta();   /* 角标跟着更新（选项备注 N 条） */
    }
    /* 题卡角标：整题笔记时间 + 选项备注条数 */
    function paintNoteMeta() {
      var q = cur(), n = noteOf(q), oc = Object.keys(optNotesOf(q)).length;
      var badge = $('#noteBadge', node), box = $('#qNote', node);
      if (badge) badge.textContent = n
        ? ('已记 · ' + noteTime(n.up || n.at) + (oc ? ' · 选项备注 ' + oc + ' 条' : ''))
        : (oc ? ('选项备注 ' + oc + ' 条') : '');
      if (box) box.classList.toggle('has-note', !!n || oc > 0);
    }
    function paintOptNotes() {
      var q = cur(), dict = optNotesOf(q);
      /* v3.10.3 防剧透：还没作答时，选项备注的只读蓝条不渲染；
         点「查看笔记」主动看过（noteRevealed）后整题笔记 + 选项备注一起可见，
         手机端没有 ✎，靠这个入口也能看到已写的选项备注。 */
      var answered = !!sess.answers[q.key] || !!noteRevealed[q.key];
      $all('.opt-note-add', opts).forEach(function (b) {
        b.classList.toggle('on', optEditing === b.getAttribute('data-letter'));
      });
      $all('.opt-note-wrap', opts).forEach(function (w) {
        var L = w.getAttribute('data-letter');
        var txt = dict[L] || '';
        var editing = optEditing === L;
        w.innerHTML = '';
        w.classList.toggle('show', (!!txt && answered) || editing);
        w.classList.toggle('editing', editing);
        if (editing) {
          var ta = document.createElement('textarea');
          ta.className = 'opt-note-input';
          ta.spellcheck = false;
          ta.value = txt;
          ta.placeholder = '这个选项哪里不对 / 怎么记（停止输入自动保存）';
          ta.addEventListener('input', function () { scheduleOptSave(q.key, L, ta.value); });
          ta.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              optNoteFlush();
              optEditing = null;
              paintOptNotes();
            }
          });
          w.appendChild(ta);
          var bar = el('div', 'opt-note-ops');
          var del = el('button', 'btn btn-sm btn-ghost', '删除');
          del.type = 'button';
          del.addEventListener('click', function () {
            setOptNote(q, L, '');
            optEditing = null;
            paintOptNotes();
            toast('已删除该选项备注');
          });
          var done = el('button', 'btn btn-sm', '收起');
          done.type = 'button';
          done.addEventListener('click', function () {
            optNoteFlush();
            optEditing = null;
            paintOptNotes();
          });
          bar.appendChild(del); bar.appendChild(done);
          w.appendChild(bar);
          setTimeout(function () { try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {} }, 0);
        } else if (txt && answered) {
          var v = el('div', 'opt-note');
          v.textContent = txt;   /* textContent：笔记内容按纯文本渲染 */
          w.appendChild(v);
        }
      });
      paintNoteMeta();
    }
    function toggleOptNote(L) {
      optNoteFlush();
      if (optEditing === L) { optEditing = null; paintOptNotes(); return; }
      optEditing = L;
      paintOptNotes();
    }

    /* 离开当前题目前把编辑框内容落库（空文本＝删笔记）；无变化不写盘 */
    function noteFlush() {
      if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
      var ta = $('#noteText', node);
      if (!ta || !noteKey) return false;
      var q = QMAP[noteKey];
      if (!q) return false;
      var prevN = noteOf(q);
      var prevTxt = prevN ? String(prevN.t || '') : '';
      var had = !!prevN;
      var keep = setNote(q, ta.value);
      /* v3.11.4 自己刚写的笔记：本题本次会话内直接可见，不用再点「查看笔记」。
         只在内容真的变了时解除防剧透——换题/退出时的兜底 flush 会原样回写，
         若也当成「新写」，旧笔记就会被顶开，防剧透形同虚设。 */
      var nowTxt = String(ta.value == null ? '' : ta.value).replace(/\s+$/, '');
      if (keep && nowTxt !== prevTxt) noteRevealed[q.key] = true;
      if (had !== keep) paintCard();   /* 答题卡紫点 / 「有笔记」计数同步 */
      var badge = $('#noteBadge', node), btn = $('#btnNoteToggle', node);
      var n = noteOf(q), oc = Object.keys(optNotesOf(q)).length;
      if (badge) badge.textContent = n
        ? ('已记 · ' + noteTime(n.up || n.at) + (oc ? ' · 选项备注 ' + oc + ' 条' : ''))
        : (oc ? ('选项备注 ' + oc + ' 条') : '');
      if (btn) btn.textContent = n ? '编辑' : '写笔记';
      var box = $('#qNote', node);
      if (box) box.classList.toggle('has-note', !!n || oc > 0);
      var view = $('#noteView', node);
      if (view) {
        var rv = !!sess.answers[q.key] || noteRevealed[q.key] || box.classList.contains('editing');
        view.textContent = (n && rv) ? n.t : '';
        view.classList.toggle('hidden', !n || !rv);
      }
      return had !== keep;
    }

    /* 答错时自动展开笔记框（只在本题还没写过笔记、且不是考试模式时），不抢焦点 */
    function noteOnWrong(q) {
      if (sess.mode !== 'practice') return;
      if (noteHasContent(db.notes[q.key])) return;
      paintNote(true);
      var ta = $('#noteText', node);
      if (ta) {
        ta.placeholder = '这题答错了，记一笔：错在哪、正确答案怎么记、下次别再踩……';
        var hint = $('#noteHint', node);
        if (hint) hint.textContent = '答错自动展开 · 停止输入后自动保存';
      }
      var btn = $('#btnNoteToggle', node);
      if (btn) btn.classList.add('pulse');
      setTimeout(function () { if (btn) btn.classList.remove('pulse'); }, 1200);
    }

    // build answer card once —— 按题型固定分组（单选→多选→判断），cell 用 data-idx 对应题序
    function pendingOf(q) {
      if (!sess.pending) sess.pending = {};
      if (sess.pending[q.key] == null) sess.pending[q.key] = sortedLetters(sess.answers[q.key] || '');
      return sess.pending[q.key];
    }

    /* 练习模式答对后自动进入下一题；最后一题返回 false */
    function autoNext() {
      if (sess.idx < sess.qs.length - 1) {
        sess.idx++;
        persistPos();
        rebuildQuestion();
        return true;
      }
      return false;
    }

    /* 练习模式做到最后一题：全部作答完毕则自动弹出交卷确认（单题组只提示），
       不再停留在最后一页等用户自己找「交卷」。考试/模拟模式不受影响（有计时与确认流程）。 */
    function maybeAutoSubmit() {
      if (!sess || sess.mode !== 'practice' || sess.done) return;
      if (sess.idx !== sess.qs.length - 1) return;
      var unanswered = sess.qs.filter(function (q) { return !sess.answers[q.key]; }).length;
      if (!unanswered) {
        if (sess.qs.length > 1) confirmSubmit();
        else toast('已答完，点「交卷」查看成绩');
      } else {
        toast('已是最后一题，还有 ' + unanswered + ' 题未作答，可点「交卷」结束（未答按错处理）');
      }
    }

    function choose(i) {
      optNoteFlush();   /* 点选项前先把正在编辑的选项备注落库 */
      var q = cur();
      var L = letterAt(i);
      if (q.t === 'multi') {
        var next = pendingOf(q);
        next = next.indexOf(L) >= 0 ? next.replace(L, '') : sortedLetters(next + L);
        if (sess.mode === 'practice' && sess.answers[q.key]) {
          var c9 = correctOf(q);
      /* 答错的多选题允许重选，再点「确认」；选对则只收藏（v3.9.4），已答对的不允许改 */
          if (!(c9 && sess.answers[q.key] !== c9)) { toast('本题已作答，可「清空本题」后重选'); return; }
        }
        sess.pending[q.key] = next;
        if (sess.mode === 'exam') {
          setAnswer(q, next);
        }
        paintOptions();
        paintCard();
        if (sess.mode === 'exam') { paintNote(false); paintOptNotes(); }  /* exam 作答后笔记切到可见 */
        return;
      }
      if (sess.mode === 'practice' && sess.answers[q.key]) {
        var c8 = correctOf(q);
        if (c8 && sess.answers[q.key] !== c8) {
          if (L === c8) { favOnCorrect(q); return; }  /* v3.9.4 答错后点正确答案 → 只收藏不改正 */
          toast('正确答案是 ' + c8 + '（已标绿），点绿色选项即可收藏'); return;
        }
        toast('本题已作答，可「清空本题」后重选'); return;
      }
      setAnswer(q, L);
      if (sess.mode === 'practice') {
        var c = correctOf(q);
        if (c && L === c) {
          removeWrong(q);
          if (autoNext()) return; // 答对自动下一题
        } else if (c) { addWrong(q); noteOnWrong(q); }
        maybeAutoSubmit();  // 最后一题答完自动引导交卷
      }
      paintOptions();
      paintCard();
      paintFeedback();
      paintNote(false);   /* 已作答：笔记从「点了才看」切到自动展示（答对已 autoNext 的不经过这里） */
      paintOptNotes();    /* 选项备注蓝条同样在作答后才亮出 */
    }

    function setAnswer(q, v) {
      if (v) sess.answers[q.key] = sortedLetters(v);
      else delete sess.answers[q.key];
      if (sess.persist) save();
    }

    /* v3.9.3 自动收藏：把本题加进「我的收藏」。返回 true 表示本次是新加入收藏。 */
    function autoFav(q) {
      if (db.fav[q.key]) return false;
      db.fav[q.key] = { pid: q.pid, n: q.n, at: Date.now() };
      save();
      var b = $('[data-act="fav"]', node);   /* 题目右上角星标同步点亮，不用等重绘 */
      if (b) { b.textContent = '★'; b.classList.add('on'); }
      return true;
    }

    /* v3.9.4 答错后点绿色正确答案：只收藏，不改正——
       答案保持你实际选的选项、错题本保留（交卷时按实际作答计分），
       本题进入「我的收藏」，可在收藏答题区重刷；停留在原题不自动跳题。 */
    function favOnCorrect(q) {
      var isNew = autoFav(q);
      paintOptions();
      paintCard();
      paintFeedback();
      toast(isNew ? '已收藏到「我的收藏」✓' : '本题已在收藏');
    }

    function paintOptions() {
      var q = cur();
      var a = sess.answers[q.key] || '';
      var c = correctOf(q);
      var showKey = sess.mode === 'practice' && !!a;
      var pending = (sess.mode === 'practice' && q.t === 'multi') ? pendingOf(q) : a;
      $all('.opt', opts).forEach(function (o) {
        var L = o.getAttribute('data-letter');
        var showPend = sess.mode === 'practice' && q.t === 'multi' && (!a || (c && a !== c));
        var sel = (showPend ? pending : a).indexOf(L) >= 0;
        o.classList.toggle('sel', sel);
        o.classList.toggle('correct', showKey && c.indexOf(L) >= 0);
        o.classList.toggle('wrong', showKey && sel && c.indexOf(L) < 0);
        var mk = $('.mark', o);
        if (showKey && c.indexOf(L) >= 0) mk.textContent = '正确答案';
        else if (showKey && sel) mk.textContent = '你的选择';
        else mk.textContent = '';
      });
      var b = $('[data-act="confirm-multi"]', node);
      /* 未作答，或已答错（可重选后确认收藏）时显示确认按钮 */
      var needConfirm = sess.mode === 'practice' && q.t === 'multi' &&
        (!sess.answers[q.key] || (c && sess.answers[q.key] !== c));
      b.classList.toggle('hidden', !needConfirm);
    }

    function paintFeedback() {
      var box = $('#qFeedback', node);
      var q = cur();
      var a = sess.answers[q.key] || '';
      if (sess.mode !== 'practice' || !a) { box.classList.add('hidden'); return; }
      var c = correctOf(q);
      box.classList.remove('hidden');
      box.className = 'feedback';
      if (!c) {
        box.classList.add('unknown');
        box.textContent = '本题尚未收录参考答案，可在「答案管理」中补充。';
      } else if (a === c) {
        box.textContent = '✓ 回答正确' + (q.an ? '　📖 ' + q.an : '');
      } else {
        box.classList.add('bad');
        var txt = '✗ 回答错误，正确答案：' + c.split('').join(' ');
        if (q.an) txt += '　📖 解析：' + q.an;
        box.textContent = txt;
      }
    }

    function paintCard() {
      var done = 0, flag = 0, noted = 0;
      var byT = { single: 0, multi: 0, judge: 0 };
      sess.qs.forEach(function (q) {
        var d = !!sess.answers[q.key];
        if (d) { done++; byT[q.t]++; }
        if (sess.flags[q.key]) flag++;
        if (noteHasContent(db.notes[q.key])) noted++;
      });
      $all('.pbar-track i', node).forEach(function (f) {
        var t = f.getAttribute('data-type');
        var tot = typeTotals[t] || 1;
        f.style.width = Math.round(byT[t] / tot * 100) + '%';
      });
      $all('.pbar-num', node).forEach(function (n) {
        var t = n.getAttribute('data-num');
        n.textContent = byT[t] + '/' + typeTotals[t];
      });
      $('#infoDone', node).textContent = String(done);
      $('#infoFlag', node).textContent = String(flag);
      var infN = $('#infoNote', node);
      if (infN) infN.textContent = String(noted);
      $('#infoLeft', node).textContent = String(sess.qs.length - done);
      $('#cardProgress', node).textContent = done + '/' + sess.qs.length;
      paintSheet();
    }

    function paintSheet() {
      var practice = sess.mode === 'practice';
      for (var i = 0; i < sess.qs.length; i++) {
        var q = sess.qs[i];
        var a = sess.answers[q.key];
        var cls = 'sheet-chip';
        if (a) {
          var c = practice ? correctOf(q) : null;
          if (practice && c && a === c) cls += ' ok';
          else if (practice && c) cls += ' bad';
          else cls += ' done';   /* 考试模式已答 / 练习模式未收录答案 */
        }
        if (sess.flags[q.key]) cls += ' flagged';
        if (noteHasContent(db.notes[q.key])) cls += ' has-note';   /* 记过笔记：右下角紫点 */
        if (i === sess.idx) cls += ' cur';
        sheetChips[i].className = cls;
      }
    }

    // footer buttons
    $('[data-act="prev"]', node).addEventListener('click', function () {
      if (sess.idx > 0) { sess.idx--; persistPos(); rebuildQuestion(); }
    });
    $('[data-act="next"]', node).addEventListener('click', function () {
      if (sess.idx < sess.qs.length - 1) { sess.idx++; persistPos(); rebuildQuestion(); }
      else toast('已经是最后一题了');
    });
    $('[data-act="mark"]', node).addEventListener('click', function () {
      var q = cur();
      sess.flags[q.key] = !sess.flags[q.key];
      if (sess.persist) save();
      paintCard();
      toast(sess.flags[q.key] ? '已标记，稍后可在答题卡查看' : '已取消标记');
    });
    $('[data-act="clear"]', node).addEventListener('click', function () {
      var q = cur();
      delete sess.answers[q.key];
      if (sess.pending) delete sess.pending[q.key];
      if (sess.persist) save();
      delete noteRevealed[q.key];   /* 清空本题＝回到未作答：笔记重新藏起来，防剧透 */
      $('#qNote', node).classList.remove('editing');   /* 编辑框也收起，否则 paintNote 会按「正在编辑」继续显示 */
      paintOptions(); paintCard(); paintFeedback();
      paintNote(false); paintOptNotes();
    });
    $('[data-act="fav"]', node).addEventListener('click', function () {
      var q = cur();
      if (db.fav[q.key]) delete db.fav[q.key];
      else db.fav[q.key] = { pid: q.pid, n: q.n, at: Date.now() };
      save(); rebuildQuestion();
    });

    /* ---- 笔记交互 ---- */
    /* 退出/切页/关页面时由 persistPos 兜底落库（整题笔记 + 选项备注一起） */
    sess.flushNote = function () { optNoteFlush(); noteFlush(); };
    var noteBox = $('#qNote', node);
    if (noteBox) {
      var ta = $('#noteText', node);
      var vb = $('#btnNoteView', node);
      if (vb) vb.addEventListener('click', function () {
        noteRevealed[cur().key] = true;   /* 用户主动看：本题本会话内不再隐藏 */
        paintNote(false);
        paintOptNotes();                  /* 选项备注蓝条一起亮出（手机端靠这个入口看备注） */
      });
      $('#btnNoteToggle', node).addEventListener('click', function () {
        var willOpen = !noteBox.classList.contains('editing');
        if (!willOpen) noteFlush();          /* 收起＝保存 */
        noteBox.classList.toggle('editing', willOpen);
        if (willOpen) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      });
      /* 停止输入 700ms 自动保存，换题/退出也不会丢 */
      ta.addEventListener('input', function () {
        if (noteTimer) clearTimeout(noteTimer);
        var hint = $('#noteHint', node);
        if (hint) hint.textContent = '正在保存…';
        noteTimer = setTimeout(function () {
          noteTimer = null;
          noteFlush();
          var h = $('#noteHint', node);
          if (h) h.textContent = '已自动保存 · Ctrl+Enter 收起';
        }, 700);
      });
      ta.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          noteFlush();
          noteBox.classList.remove('editing');
          paintNote(false);   /* 保存后按「自己写的直接可见」重绘正文 */
          toast(noteOf(cur()) ? '笔记已保存' : '笔记已清空');
        }
      });
      $('[data-act="note-save"]', node).addEventListener('click', function () {
        noteFlush();
        noteBox.classList.remove('editing');
        paintNote(false);
        toast(noteOf(cur()) ? '笔记已保存' : '笔记已清空');
      });
      $('[data-act="note-del"]', node).addEventListener('click', function () {
        var q = cur();
        if (!noteOf(q)) { noteBox.classList.remove('editing'); return; }
        showModal('删除本题笔记？', '将清空 #' + q.n + ' 的笔记内容（其他题不受影响）。', '删除', function () {
          if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
          delete db.notes[q.key];
          save();
          paintNote(false);
          noteBox.classList.remove('editing');
          paintCard();   /* v3.11.4 答题卡紫点 / 「有笔记」计数同步 */
          toast('笔记已删除');
        });
      });
    }
    $('[data-act="confirm-multi"]', node).addEventListener('click', function () {
      var q = cur();
      var v = pendingOf(q);
      if (!v) { toast('请先选择至少一个选项'); return; }
      var prev = sess.answers[q.key] || '';
      var c = correctOf(q);
      /* v3.9.4 已答错的多选：重选后再确认，若选中的正是正确答案 → 只收藏不改正
         （答案保持原错项、错题本保留、停在原题），与单选点绿色答案行为一致 */
      if (sess.mode === 'practice' && c && prev && prev !== c && v === c) {
        favOnCorrect(q);
        return;
      }
      setAnswer(q, v);
      if (c && v === c) {
        removeWrong(q);
        if (autoNext()) return; // 多选确认后答对自动下一题
      } else if (c) { addWrong(q); noteOnWrong(q); }
      paintOptions(); paintCard(); paintFeedback();
      paintNote(false); paintOptNotes();   /* 已作答：笔记切到可见 */
      maybeAutoSubmit();  // 最后一题答完自动引导交卷
    });
    $('[data-act="toggle-card"]', node).addEventListener('click', function () {
      $('#sideCard', node).classList.toggle('open');
    });
    // 分类模式：切换到只练该题型的模块会话（保留已答）；「全部」切回整套
    $all('[data-act="jump-type"]', node).forEach(function (b) {
      b.addEventListener('click', function () {
        if (!sess.pid) { toast('本练习不支持题型切换'); return; }
        var mod = b.getAttribute('data-type');
        var pid = sess.pid, mode = sess.mode;
        var ms = modState(pid, mod);
        persistPos();
        if (ms.order && !ms.done) beginSession(pid, mod, mode, {});
        else beginSession(pid, mod, mode, { fresh: true, random: false });
      });
    });
    // 跳转栏：按全局题号（#号，如 #850 或 850）跳转，随机顺序/分类模式下同样有效
    $('[data-act="jump-no"]', node).addEventListener('click', function () {
      var inp = $('#jumpNo', node);
      var no = parseInt(String(inp.value).replace(/[^\d]/g, ''), 10);
      if (!no) { toast('请输入题号，如 #850'); return; }
      var i = sess.qs.findIndex(function (x) { return x.n === no; });
      if (i < 0) { toast('本次练习中没有第 ' + no + ' 题'); return; }
      sess.idx = i; persistPos(); rebuildQuestion();
      inp.value = '';
    });
    $('#jumpNo', node).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('[data-act="jump-no"]', node).click(); }
    });
    /* ---------- 关键词搜题：匹配题干/选项/知识点/解析，点结果直达该题 ---------- */
    var searchBox = $('#searchKw', node), drop = $('#searchDrop', node);
    var searchTimer = null, searchKw0 = '', searchHits = [];
    function runSearch() {
      var kw = searchBox.value.trim().toLowerCase();
      searchKw0 = kw;
      searchHits = [];
      if (kw.length < 2) { drop.classList.add('hidden'); drop.innerHTML = ''; return; }
      var all = PAPERS[0].questions;   /* 单题库：官方题库全量搜索 */
      for (var i = 0; i < all.length; i++) {
        var q = all[i];
        var hay = (q.q + ' ' + q.o.join(' ') + ' ' + (q.kp || '') + ' ' + (q.an || '')).toLowerCase();
        if (hay.indexOf(kw) >= 0) { searchHits.push(q); if (searchHits.length >= 60) break; }
      }
      drop.innerHTML = '';
      if (!searchHits.length) {
        drop.appendChild(el('div', 'search-empty', '没有匹配「' + searchBox.value.trim() + '」的题目'));
      } else {
        searchHits.slice(0, 8).forEach(function (q) {
          var r = el('button', 'search-row');
          r.type = 'button';
          var stem = q.q.replace(/\s+/g, ' ');
          r.innerHTML = '<b>#' + q.n + '</b><span class="st">' + typeName(q.t) + '</span>' +
            '<span class="sq">' + escHtml(stem.slice(0, 46)) + (stem.length > 46 ? '…' : '') + '</span>';
          r.addEventListener('click', function () { gotoHit(q); });
          drop.appendChild(r);
        });
        if (searchHits.length > 8) {
          drop.appendChild(el('div', 'search-more', '共 ' + searchHits.length + ' 条匹配，显示前 8 条；回车直达第一条'));
        }
      }
      drop.classList.remove('hidden');
    }
    function gotoHit(q) {
      drop.classList.add('hidden');
      var i = sess.qs.findIndex(function (x) { return x.key === q.key; });
      if (i >= 0) {   /* 在当前练习里：直接跳过去 */
        sess.idx = i; persistPos(); rebuildQuestion();
        searchBox.value = '';
        return;
      }
      /* 不在当前练习：把全部匹配题组成一个搜索练习，直接落在该题上（断点可续） */
      var qs = searchHits.slice().sort(function (a, b) { return a.n - b.n; });
      var at = qs.findIndex(function (x) { return x.key === q.key; });
      showModal('本题不在本次练习中',
        '第 ' + q.n + ' 题（' + typeName(q.t) + '）不在当前练习范围。可以把「' + escHtml(searchKw0) + '」匹配到的 <b>' +
        qs.length + '</b> 道题组成一个搜索练习，直接从第 ' + q.n + ' 题开始做（练习模式，进度自动保存）。',
        '直达该题', function () {
          sess = {
            pid: null, mod: null, title: '搜索：' + searchKw0, mode: 'practice', qs: qs,
            answers: {}, flags: {}, idx: Math.max(0, at), st: null, ms: null,
            persist: true, tempKey: 'search', startAt: Date.now(), pending: {},
            deadline: 0, limit: 0, done: false, random: false
          };
          route = 'quiz'; render();
        }, '取消');
      searchBox.value = '';
    }
    searchBox.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 220);   /* 输入停顿 220ms 再搜，避免每键全库扫 */
    });
    searchBox.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (searchHits.length) gotoHit(searchHits[0]); }
      else if (e.key === 'Escape') { drop.classList.add('hidden'); }
    });
    node.addEventListener('click', function (e) {   /* 点搜索框/下拉以外处收起结果 */
      if (!drop.contains(e.target) && e.target !== searchBox) drop.classList.add('hidden');
    });
    /* v3.11.1 交卷弹窗的未答题跳转：注册本视图的跳转实现（离开时在 exit 里置空） */
    quizJump = function (i) {
      sess.idx = i;
      persistPos();
      rebuildQuestion();
      window.scrollTo(0, 0);
    };
    $('[data-act="submit"]', node).addEventListener('click', function () { confirmSubmit(); });
    $('[data-act="exit"]', node).addEventListener('click', function () {
      var answered = Object.keys(sess.answers).length;
      var pid = sess.pid, mode = sess.mode;
      function leave() {
        persistPos();
        sess = null;
        quizJump = null;   /* v3.11.1 离开答题页，跳转回调作废 */
        if (pid) { pick.pid = pid; pick.mode = mode; route = 'paper'; }
        else route = 'home';
        render();
      }
      if (answered && !sess.done) {
        showModal('暂时离开？', '作答进度会保存，下次点「继续」接着做。要换设备继续答，可到「答案管理」点「备份全部进度」，在另一台设备上「恢复备份」即可接着做（未交卷进度也包含在内，错题会合并进对方错题本）。', '离开', leave, '继续答题');
      } else leave();
    });

    rebuildQuestion();
    return node;
  }

  function confirmSubmit() {
    /* v3.11.1 未答题跳转：交卷确认弹窗里列出所有没答的题号，点一下直接跳到那题继续作答 */
    var un = [];
    sess.qs.forEach(function (q, i) { if (!sess.answers[q.key]) un.push(i); });
    var msg = '共 ' + sess.qs.length + ' 题，已答 ' + (sess.qs.length - un.length) + ' 题';
    if (un.length) msg += '，还有 ' + un.length + ' 题未作答（按错处理），点下方题号可跳过去作答';
    msg += '。交卷后即可查看答案与解析。';
    showModal('确认交卷？', msg, '交卷', function () { evaluateAndFinish(false); });
    if (!un.length) return;
    var m = document.querySelector('#modalRoot .modal-mask:last-child .modal');
    if (!m) return;
    var wrap = el('div', 'un-jump');
    var CAP = 60;  /* 芯片数量上限：再多弹窗塞不下，剩下的下一轮交卷继续跳 */
    un.slice(0, CAP).forEach(function (i) {
      var chip = el('button', 'un-chip', String(i + 1));
      chip.title = '第 ' + (i + 1) + ' 题（未作答），点击跳转';
      chip.addEventListener('click', function () {
        /* 点题号 = 不交卷了，关掉弹窗回到该题 */
        var mask = chip.closest('.modal-mask');
        if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
        if (quizJump) quizJump(i);
      });
      wrap.appendChild(chip);
    });
    if (un.length > CAP) {
      wrap.appendChild(el('div', 'un-more', '…其余 ' + (un.length - CAP) + ' 题未答，先作答上面的题，再次交卷时可继续跳转'));
    }
    m.insertBefore(wrap, m.querySelector('.acts'));
  }

  function evaluateAndFinish(auto) {
    var s = sess;
    var r = evaluate(s);
    var used = usedSec();
    if (s.persist && s.ms) {
      s.ms.done = true;
      s.ms.score = r.score;
      s.ms.total = r.total;
      s.ms.used = Math.round(used);
      s.ms.idx = s.idx;
      s.ms.at = Date.now();
    }
    s.qs.forEach(function (q) {
      var c = correctOf(q), a = s.answers[q.key] || '';
      if (!c || !a) return;
      if (a === c) removeWrong(q); else addWrong(q);
    });
    if (s.persist) {
      var snap = {};
      s.qs.forEach(function (q) { if (s.answers[q.key]) snap[q.key] = s.answers[q.key]; });
      db.history.push({
        pid: s.pid, mod: s.mod || null, mode: s.mode, score: r.score, total: r.total,
        at: Date.now(), used: Math.round(used), random: !!s.random, snap: snap,
        label: s.title
      });
      if (db.history.length > 200) db.history = db.history.slice(-200);
      if (s.tempKey) db.temp = null;  /* 交卷后清除断点 */
      save();
    }
    lastResult = { sess: s, r: r, used: used };
    revOnlyWrong = true;   /* 交卷后默认只看错题，正确题按需展开 */
    revShown = REV_PAGE;
    route = 'result';
    render();
    if (auto) toast('时间到，已自动交卷');
  }

  /* ---------------- result ---------------- */
  function viewResult() {
    var node = cloneTpl('tpl-result');
    var s = lastResult.sess, r = lastResult.r;
    var pct = r.total ? r.score / r.total : 0;

    $('#scoreVal', node).textContent = String(r.score);
    $('#scoreOf', node).textContent = '得分 / ' + r.total;
    $('#resTitle', node).textContent = s.mode === 'exam' ? '交卷完成' : '练习完成';
    var praise = pct >= 0.9 ? '状态非常好，保持手感。' : pct >= 0.75 ? '基础扎实，重点补错题。' : pct >= 0.6 ? '还有提升空间，建议按章节重刷。' : '建议先过一遍错题，再重做本卷。';
    $('#resSub', node).textContent = s.title + ' · 用时 ' + fmtUsed(lastResult.used) + ' · 正确率 ' + Math.round(pct * 100) + '%　' + praise;

    var ring = $('#ring', node);
    var C = 2 * Math.PI * 64;
    ring.setAttribute('stroke-dasharray', String(C));
    ring.setAttribute('stroke-dashoffset', String(C));
    var color = pct >= 0.8 ? '#16a34a' : pct >= 0.6 ? '#3b5bdb' : '#dc2626';
    ring.setAttribute('stroke', color);
    setTimeout(function () {
      ring.style.transition = 'stroke-dashoffset 1s cubic-bezier(.2,.8,.3,1)';
      ring.setAttribute('stroke-dashoffset', String(C * (1 - pct)));
    }, 60);

    var kpis = $('#resKpis', node);
    var kpiList = [['用时', fmtUsed(lastResult.used)]];
    TYPES.forEach(function (t) {
      if (r.stat[t][1] > 0) kpiList.push([typeLabel(t), r.stat[t][0] + ' / ' + r.stat[t][1]]);
    });
    kpiList.forEach(function (x) {
      var k = cloneTpl('tpl-kpi');
      $('span', k).textContent = x[0];
      $('b', k).textContent = x[1];
      kpis.appendChild(k);
    });

    var revBox = $('#review', node);
    var toggle = $('#revToggle', node);
    /* 逐题回顾：默认只渲染错题；正确题按 60 条一批展开。
       1445 题整卷全量渲染会产生一万多个 DOM 节点，交卷时明显卡顿。 */
    function revSource() {
      return s.qs.filter(function (q) {
        if (!revOnlyWrong) return true;
        var c = correctOf(q), a = s.answers[q.key] || '';
        return !c || a !== c;
      });
    }
    function revItem(q) {
      var item = cloneTpl('tpl-review');
      var c = correctOf(q), a = s.answers[q.key] || '';
      var ok = c && a === c;
      item.classList.toggle('bad', !ok);
      $('.no', item).textContent = PAPERS.length > 1 ? (q.pid + ' 卷 第 ' + q.n + ' 题') : ('#' + q.n);
      var tag = $('.tag', item);
      tag.textContent = typeName(q.t);
      tag.className = typeTagClass(q.t);
      var badge = el('span', 'ans-badge ' + (ok ? 'ok' : (c ? 'bad' : 'mid')), ok ? '答对' : (c ? (a ? '答错' : '未作答') : '未收录答案'));
      $('.badge-wrap', item).appendChild(badge);
      $('.rs', item).textContent = q.q;
      $('.ro-my span', item).textContent = a ? a.split('').join(' ') : '未作答';
      $('.ro-ck span', item).textContent = c ? c.split('').join(' ') : '—';
      if (q.an) item.appendChild(el('p', 'r-an', '📖 解析：' + q.an));
      return item;
    }
    function paintReview() {
      var list = revSource();
      revBox.innerHTML = '';
      if (!list.length) {
        revBox.appendChild(el('div', 'empty', revOnlyWrong ? '本次没有错题，全部答对 🎉' : '本次没有可回顾的题目'));
        toggle.textContent = revOnlyWrong ? ('显示全部（' + s.qs.length + ' 题）') : '只看错题';
        return;
      }
      var frag = document.createDocumentFragment();
      list.slice(0, revShown).forEach(function (q) { frag.appendChild(revItem(q)); });
      revBox.appendChild(frag);
      var rest = list.length - revShown;
      if (rest > 0) {
        var more = el('button', 'btn more-btn',
          '再显示 ' + Math.min(REV_PAGE, rest) + ' 条（还有 ' + rest + ' 条）');
        more.addEventListener('click', function () { revShown += REV_PAGE; paintReview(); });
        revBox.appendChild(more);
      }
      toggle.textContent = revOnlyWrong ? ('显示全部（' + s.qs.length + ' 题）') : '只看错题';
    }
    paintReview();
    toggle.addEventListener('click', function () {
      revOnlyWrong = !revOnlyWrong;
      revShown = REV_PAGE;
      paintReview();
    });

    $('[data-act="retry"]', node).addEventListener('click', function () {
      if (s.persist && s.pid) redoModule(s.pid, s.mod || 'all', s.mode, s.random);
      else beginSet(s.qs.map(function (q) { return q; }), s.title, s.mode, s.random, s.persist);
    });
    $('[data-act="to-paper"]', node).addEventListener('click', function () {
      if (s.pid) { pick.pid = s.pid; pick.mode = s.mode; route = 'paper'; render(); }
      else { route = 'home'; render(); }
    });
    $('[data-act="to-wrong"]', node).addEventListener('click', function () { route = 'wrong'; render(); });
    $('[data-act="home"]', node).addEventListener('click', function () { route = 'home'; render(); });
    return node;
  }

  /* 生成可打印 / 可存 Word 的题目列表 HTML（错题本、收藏导出用） */
  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function buildListHtml(kind, qs) {
    var title = kind === 'wrong' ? '错题本' : '我的收藏';
    var rows = qs.map(function (q) {
      var c = correctOf(q);
      var opts = q.o.map(function (o, j) {
        var L = letterAt(j);
        var mark = c && c.indexOf(L) >= 0 ? ' <b style="color:green">✓</b>' : '';
        return '<p style="margin:2px 0 2px 1em">' + L + '．' + escHtml(o) + mark + '</p>';
      }).join('');
      return '<div style="margin:0 0 16px;page-break-inside:avoid">' +
        '<p style="margin:0"><b>#' + q.n + '（' + typeName(q.t) + '）</b>　' + escHtml(q.q) + '</p>' +
        opts +
        '<p style="margin:4px 0 0;color:green">答案：' + escHtml(c || '—') +
        (q.kp ? '　｜　知识点：' + escHtml(q.kp) : '') + '</p>' +
        (q.an ? '<p style="margin:2px 0 0;color:#555">解析：' + escHtml(q.an) + '</p>' : '') +
        '</div>';
    }).join('');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title></head>' +
      '<body style="font-family:\'Microsoft YaHei\',sans-serif;font-size:12pt;line-height:1.7;max-width:800px;margin:0 auto">' +
      '<h2>' + title + '（' + qs.length + ' 题）· 人工智能训练师理论题库</h2>' + rows + '</body></html>';
  }
  function downloadBlob(content, mime, filename) {
    var blob = new Blob([content], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* 唯一会往本地写文件的入口：用户主动点「备份到本地」才下载。
     清空作答、答错、翻题等一切自动流程都不下载，数据只留在浏览器 localStorage。 */
  function exportAllBackup() {
    var d = new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
    /* backupVer:2 外壳：携带导出设备名，对方恢复时错题/笔记按来源合并标记 */
    var pack = { backupVer: 2, deviceName: deviceName(), exportedAt: Date.now(), db: db };
    downloadBlob(JSON.stringify(pack, null, 2), 'application/json', '练习进度备份_' + stamp + '.json');
    var mid = db.temp && db.temp.order && Object.keys(db.temp.answers || {}).length ? '、未交卷的临时练习' : '';
    toast('已导出全部进度（作答位置' + mid + '、错题、收藏、笔记 ' + noteCount() + ' 条、历史记录）——发到另一台设备「恢复备份」即可接着答，错题与笔记会合并进对方');
  }

  /* ---------------- lists ---------------- */
  function viewList(kind) {
    var node = cloneTpl('tpl-list');
    var map = kind === 'wrong' ? db.wrong : db.fav;
    var title = kind === 'wrong' ? '错题本' : '我的收藏';
    $('#listTitle', node).textContent = title;
    var desc = $('#listDesc', node);
    var body = $('#listBody', node);
    var filter = 'all';
    var reviewMode = false;
    var srcFilter = 'all';

    function allQs() {
      /* 错题按加入时间升序：先从最早错的开始重练；收藏保持最新在前 */
      return Object.keys(map).sort(function (a, b) {
        return kind === 'wrong' ? (map[a].at || 0) - (map[b].at || 0) : (map[b].at || 0) - (map[a].at || 0);
      }).map(function (k) { return QMAP[k]; }).filter(Boolean);
    }
    function sessLabel(h) {
      return h.label || ((h.pid && BY_ID[h.pid] ? BY_ID[h.pid].title : '混合练习') +
        ' · ' + (h.mod ? modLabel(h.mod) : '混合') + ' · ' + (h.mode === 'exam' ? '考试' : '练习'));
    }
    /* 该错题最近一次做错的那次练习（从最新交卷记录往前找第一个含该题答错的快照） */
    function originOf(k) {
      var q = QMAP[k]; if (!q) return null;
      var c = correctOf(q); if (!c) return null;
      for (var i = db.history.length - 1; i >= 0; i--) {
        var h = db.history[i];
        if (h.snap && h.snap[k] && h.snap[k] !== c) return h;
      }
      return null;
    }
    function visibleQs() {
      var arr = allQs();
      if (filter !== 'all') arr = arr.filter(function (q) { return q.t === filter; });
      /* 按练习场次筛选：只看某一次练习产生的错题 */
      if (kind === 'wrong' && srcFilter !== 'all') {
        arr = arr.filter(function (q) {
          var o = originOf(q.key);
          return srcFilter === 'none' ? !o : (o && String(o.at) === srcFilter);
        });
      }
      return arr;
    }
    function fmtDate(t) {
      var d = new Date(t || Date.now());
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    function reviewRows() {
      var items = db.history.slice().reverse();
      if (!items.length) {
        body.appendChild(el('div', 'empty', '还没有练习记录，做完一套卷子后这里就能回顾 📚'));
        return;
      }
      items.forEach(function (h) {
        var row = el('div', 'row');
        var left = el('div', 'grow');
        left.appendChild(el('div', 'qtext', h.label || ((h.pid && BY_ID[h.pid] ? BY_ID[h.pid].title : '混合练习') +
          ' · ' + (h.mod ? modLabel(h.mod) : '混合') + ' · ' + (h.mode === 'exam' ? '考试' : '练习'))));
        left.appendChild(el('div', 'qsub', fmtDate(h.at) + ' · 得分 ' + h.score + '/' + (h.total || 100) +
          ' · 用时 ' + fmtUsed(h.used || 0) + (h.random ? ' · 随机' : '')));
        row.appendChild(left);
        if (h.snap) {
          var n = wrongKeysOf(h).length;
          var btn = el('button', 'btn btn-sm btn-ghost', '错题 ' + n + ' 道 →');
          btn.addEventListener('click', function () { reviewH = h; route = 'review'; render(); });
          row.appendChild(btn);
        } else {
          row.appendChild(el('span', 'hint', '无快照，不可回顾'));
        }
        body.appendChild(row);
      });
    }
    function paint() {
      body.innerHTML = '';
      if (reviewMode) {
        desc.textContent = '按交卷顺序回顾每一次练习的错题（带快照的练习才可回顾）。';
        reviewRows();
        return;
      }
      if (kind === 'wrong') {
        var nSrc = Object.keys(db.wrong).filter(function (k) { return db.wrong[k] && db.wrong[k].src; }).length;
        desc.textContent = '共 ' + allQs().length + ' 道' +
          (nSrc ? '，其中 ' + nSrc + ' 道来自其他设备的备份' : '') +
          '。答对后会自动移出；也可手动移除。每次交卷的错题可在上方「练习回顾」按次查看。';
      } else {
        desc.textContent = '共 ' + allQs().length + ' 道。点上方「开始练习」进入收藏答题区，按练习模式作答（答对答错即时反馈）。';
      }
      var qs = visibleQs();
      if (!qs.length) {
        body.appendChild(el('div', 'empty', kind === 'wrong'
          ? (filter === 'all' ? '还没有错题，去刷一套卷子吧 📚' : '该题型下没有错题')
          : (filter === 'all' ? '还没有收藏，点题目右上角 ☆ 收藏' : '该题型下没有收藏')));
      }
      qs.forEach(function (q) {
        var row = cloneTpl('tpl-row');
        var tag = $('.tag', row);
        tag.textContent = typeName(q.t);
        tag.className = typeTagClass(q.t);
        $('.qtext', row).textContent = (PAPERS.length > 1 ? q.pid + ' 卷 第 ' + q.n + ' 题' : '#' + q.n) + ' · ' + q.q;
        var c = correctOf(q);
        var sub = $('.qsub', row);
        sub.textContent = c ? ('参考答案：' + c.split('').join(' ')) : '答案未收录';
        /* 来自备份的错题显示来源标记 */
        if (kind === 'wrong' && map[q.key] && map[q.key].src) {
          sub.appendChild(el('span', 'src-badge', '来自「' + map[q.key].src + '」的备份'));
        }
        /* 该题最近一次做错来自哪次练习 */
        if (kind === 'wrong' && !reviewMode) {
          var o = originOf(q.key);
          if (o) sub.appendChild(el('span', 'origin-info',
            '来自练习：' + sessLabel(o) + '（' + fmtDate(o.at) + '）'));
        }
        /* 写过笔记的题：列表里直接把笔记摘要带出来（点「查看」进单题即可改） */
        var nt = db.notes[q.key];
        if (noteHasContent(nt)) {
          var nsum = nt.t || ('选项备注 ' + Object.keys(nt.o || {}).length + ' 条');
          var nb = el('span', 'note-badge-row',
            '📝 ' + (nsum.length > 70 ? nsum.slice(0, 70) + '…' : nsum));
          nb.title = nt.t || '';
          sub.appendChild(nb);
        }
        $('[data-act="row-go"]', row).addEventListener('click', function () {
          beginSet([q], PAPERS.length > 1 ? q.pid + ' 卷 第 ' + q.n + ' 题' : '#' + q.n + ' 单题重练', 'practice');
        });
        $('[data-act="row-del"]', row).addEventListener('click', function () {
          delete map[q.key]; save(); paint();
        });
        body.appendChild(row);
      });
    }

    var filterRow = el('div', 'filter-row');
    [['all', '全部'], ['single', '单选'], ['multi', '多选'], ['judge', '判断']].forEach(function (f) {
      var b = el('button', 'fbtn' + (f[0] === 'all' ? ' on' : ''), f[1]);
      b.addEventListener('click', function () {
        filter = f[0];
        $all('.fbtn', filterRow).forEach(function (x) { x.classList.toggle('on', x === b); });
        paint();
      });
      filterRow.appendChild(b);
    });
    $('.panel', node).insertBefore(filterRow, body);

    if (kind === 'wrong') {
      var tabRow = el('div', 'filter-row');
      var tCur = el('button', 'fbtn on', '当前错题');
      var tRev = el('button', 'fbtn', '练习回顾');
      tCur.addEventListener('click', function () {
        reviewMode = false;
        tCur.classList.add('on'); tRev.classList.remove('on');
        filterRow.style.display = '';
        srcSel.style.display = '';
        fillSrc();
        paint();
      });
      tRev.addEventListener('click', function () {
        reviewMode = true;
        tRev.classList.add('on'); tCur.classList.remove('on');
        filterRow.style.display = 'none';
        srcSel.style.display = 'none';
        paint();
      });
      tabRow.appendChild(tCur); tabRow.appendChild(tRev);
      $('.panel', node).insertBefore(tabRow, filterRow);

      /* 按练习场次筛选当前错题 */
      var srcSel = document.createElement('select');
      srcSel.className = 'src-select';
      srcSel.title = '只看某一次练习产生的错题';
      function fillSrc() {
        srcSel.innerHTML = '';
        var opt0 = document.createElement('option');
        opt0.value = 'all';
        opt0.textContent = '全部练习';
        srcSel.appendChild(opt0);
        var byAt = {};
        Object.keys(db.wrong).forEach(function (k) {
          var o = originOf(k);
          if (o) {
            if (!byAt[o.at]) byAt[o.at] = { h: o, n: 0 };
            byAt[o.at].n++;
          }
        });
        var none = Object.keys(db.wrong).filter(function (k) { return !originOf(k); }).length;
        Object.keys(byAt).sort(function (a, b) { return b - a; }).forEach(function (at) {
          var x = byAt[at];
          var op = document.createElement('option');
          op.value = String(at);
          op.textContent = sessLabel(x.h) + ' · ' + fmtDate(Number(at)) + '（' + x.n + ' 题）';
          srcSel.appendChild(op);
        });
        if (none) {
          var opN = document.createElement('option');
          opN.value = 'none';
          opN.textContent = '其他来源（备份导入等）· ' + none + ' 题';
          srcSel.appendChild(opN);
        }
        if (srcFilter !== 'all' && srcFilter !== 'none' && !byAt[Number(srcFilter)]) srcFilter = 'all';
        srcSel.value = srcFilter;
      }
      fillSrc();
      srcSel.addEventListener('change', function () { srcFilter = srcSel.value; paint(); });
      $('.panel', node).insertBefore(srcSel, filterRow);
    }

    var bStart = $('[data-act="list-practice"]', node);
    bStart.textContent = kind === 'wrong' ? '开始重练' : '⭐ 开始练习（收藏答题区）';
    bStart.addEventListener('click', function () {
      var qs = visibleQs();
      if (!qs.length) { toast('列表是空的'); return; }
      /* 收藏题目进入专属答题区：练习模式、按当前筛选列表作答 */
      beginSet(qs, kind === 'wrong' ? title + ' · 重练' : title + ' · 练习', 'practice');
    });
    /* 打印 / 导出 Word（按当前筛选的列表） */
    var bPrint = el('button', 'btn', '🖨 打印');
    bPrint.addEventListener('click', function () {
      var qs = visibleQs();
      if (!qs.length) { toast('列表是空的'); return; }
      var w = window.open('', '_blank');
      if (!w) { toast('浏览器拦截了弹窗，请允许弹窗后重试'); return; }
      w.document.write(buildListHtml(kind, qs));
      w.document.close();
      w.focus();
      setTimeout(function () { w.print(); }, 300);
    });
    var bWord = el('button', 'btn', '⬇ 导出 Word');
    bWord.addEventListener('click', function () {
      var qs = visibleQs();
      if (!qs.length) { toast('列表是空的'); return; }
      downloadBlob('\ufeff' + buildListHtml(kind, qs), 'application/msword', title + '_' + qs.length + '题.doc');
      toast('已导出 ' + qs.length + ' 题（.doc 可用 Word/WPS 打开）');
    });
    $('#listOps', node).appendChild(bPrint);
    $('#listOps', node).appendChild(bWord);
    $('[data-act="list-clear"]', node).addEventListener('click', function () {
      if (!allQs().length) return;
      showModal('清空' + title + '？', '该操作不可撤销。', '清空', function () {
        allQs().forEach(function (q) { delete map[q.key]; });
        save(); paint();
      });
    });
    paint();
    return node;
  }

  /* ---------------- 我的笔记（只看写过笔记的题，可就地改） ---------------- */
  function viewNotes() {
    var node = cloneTpl('tpl-list');
    $('#listTitle', node).textContent = '我的笔记';
    var desc = $('#listDesc', node);
    var body = $('#listBody', node);
    var ops = $('#listOps', node);
    var filter = 'all';

    function fmt(t) {
      var d = new Date(t || Date.now());
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    function allQs() {
      return Object.keys(db.notes)
        .filter(function (k) { return noteHasContent(db.notes[k]); })
        .sort(function (a, b) {
          return (db.notes[b].up || db.notes[b].at || 0) - (db.notes[a].up || db.notes[a].at || 0);
        })
        .map(function (k) { return QMAP[k]; })
        .filter(Boolean);
    }

    /* 操作区：重练 / 打印带笔记的清单 / 清空 */
    ops.innerHTML = '';
    var bPrac = el('button', 'btn btn-primary', '重练有笔记的题');
    var bPrint = el('button', 'btn', '🖨 打印笔记');
    var bClear = el('button', 'btn', '清空全部笔记');
    bClear.style.color = 'var(--bad)';
    ops.appendChild(bPrac); ops.appendChild(bPrint); ops.appendChild(bClear);

    function paint() {
      body.innerHTML = '';
      var all = allQs();
      var qs = all.filter(function (q) { return filter === 'all' || q.t === filter; });
      desc.textContent = '共 ' + all.length + ' 道题写了笔记，按最近修改排序。' +
        '答题时题卡下方就是笔记框，答错会自动展开；笔记跟着题目走，任何模式做到同一题都能看到，' +
        '备份/恢复也会一起带走。';
      if (!qs.length) {
        body.appendChild(el('div', 'empty', all.length
          ? '该题型下没有笔记'
          : '还没有笔记。答题时在题卡下方点「写笔记」记一笔，下次做到这题会自动显示 📝'));
        return;
      }
      qs.forEach(function (q) {
        var n = db.notes[q.key];
        var row = el('div', 'row note-row');
        var tag = el('span', 'tag', typeName(q.t));
        tag.className = typeTagClass(q.t);
        row.appendChild(tag);

        var grow = el('div', 'grow');
        grow.appendChild(el('div', 'qtext', '#' + q.n + ' · ' + q.q));
        var txt = el('div', 'qsub note-text', n.t || '');
        if (!n.t) txt.classList.add('hidden');
        grow.appendChild(txt);
        /* 选项备注：逐条列出（A：… / B：…），可在答题页的选项后继续改 */
        var on = n.o || {};
        Object.keys(on).sort().forEach(function (L) {
          grow.appendChild(el('div', 'opt-note', L + '：' + on[L]));
        });
        grow.appendChild(el('div', 'note-when', '更新于 ' + fmt(n.up || n.at)));
        row.appendChild(grow);

        var bGo = el('button', 'btn btn-sm btn-ghost', '去答题');
        bGo.addEventListener('click', function () {
          beginSet([q], '#' + q.n + ' 笔记题重练', 'practice');
        });
        var editing = false, ta = null;
        var bEdit = el('button', 'btn btn-sm btn-ghost', '编辑');
        bEdit.addEventListener('click', function () {
          if (!editing) {
            editing = true;
            ta = document.createElement('textarea');
            ta.className = 'note-inline';
            ta.spellcheck = false;
            ta.value = n.t || '';
            txt.classList.add('hidden');
            grow.insertBefore(ta, txt);
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
            bEdit.textContent = '保存';
            bEdit.classList.remove('btn-ghost');
            bEdit.classList.add('btn-primary');
            return;
          }
          setNote(q, ta.value);   /* 空文本清整题笔记，选项备注由 setNote 内部保留 */
          toast(noteHasContent(db.notes[q.key]) ? '笔记已保存' : '笔记已清空');
          paint();
        });
        var bDel = el('button', 'btn btn-sm btn-ghost', '删除');
        bDel.addEventListener('click', function () {
          showModal('删除这条笔记？', '#' + q.n + ' 的笔记内容将被清空（题目本身不受影响）。', '删除', function () {
            delete db.notes[q.key];
            save(); paint();
            toast('笔记已删除');
          });
        });
        row.appendChild(bGo); row.appendChild(bEdit); row.appendChild(bDel);
        body.appendChild(row);
      });
    }

    var filterRow = el('div', 'filter-row');
    [['all', '全部'], ['single', '单选'], ['multi', '多选'], ['judge', '判断']].forEach(function (f) {
      var b = el('button', 'fbtn' + (f[0] === 'all' ? ' on' : ''), f[1]);
      b.addEventListener('click', function () {
        filter = f[0];
        $all('.fbtn', filterRow).forEach(function (x) { x.classList.toggle('on', x === b); });
        paint();
      });
      filterRow.appendChild(b);
    });
    $('.panel', node).insertBefore(filterRow, body);

    bPrac.addEventListener('click', function () {
      var qs = allQs().filter(function (q) { return filter === 'all' || q.t === filter; });
      if (!qs.length) { toast('还没有笔记'); return; }
      beginSet(qs, '笔记重练（' + qs.length + ' 题）', 'practice');
    });
    bPrint.addEventListener('click', function () {
      var qs = allQs().filter(function (q) { return filter === 'all' || q.t === filter; });
      if (!qs.length) { toast('还没有笔记'); return; }
      var rows = qs.map(function (q) {
        var n = db.notes[q.key] || {};
        var c = correctOf(q);
        var on = n.o || {};
        var optHtml = Object.keys(on).sort().map(function (L) {
          return '<p style="margin:2px 0 2px 14px;color:#1e40af">· ' + L + '：' + escHtml(on[L]) + '</p>';
        }).join('');
        return '<div style="border-bottom:1px dashed #ccc;padding:10px 0;page-break-inside:avoid">' +
          '<p style="margin:0 0 4px;font-weight:bold">#' + q.n + ' [' + typeName(q.t) + '] ' + escHtml(q.q) + '</p>' +
          '<p style="margin:2px 0;color:#0f7a3d">参考答案：' + escHtml(c || '未收录') + '</p>' +
          (n.t ? '<p style="margin:2px 0;color:#1e40af">📝 笔记：' + escHtml(n.t) + '</p>' : '') +
          (optHtml ? '<p style="margin:2px 0;color:#1e40af">📝 选项备注：</p>' + optHtml : '') +
          '</div>';
      }).join('');
      var w = window.open('', '_blank');
      if (!w) { toast('浏览器拦截了弹窗，请允许弹窗后重试'); return; }
      w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>我的笔记</title></head>' +
        '<body style="font-family:\'Microsoft YaHei\',sans-serif;font-size:12pt;line-height:1.7;max-width:800px;margin:0 auto">' +
        '<h2>我的笔记（' + qs.length + ' 题）· 人工智能训练师理论题库</h2>' + rows + '</body></html>');
      w.document.close();
      w.focus();
      setTimeout(function () { w.print(); }, 300);
    });
    bClear.addEventListener('click', function () {
      var n = allQs().length;
      if (!n) return;
      showModal('清空全部笔记？', '共 ' + n + ' 条笔记将被删除，该操作不可撤销（建议先「备份全部进度」）。', '清空', function () {
        db.notes = {};
        save(); paint();
        toast('已清空全部笔记');
      });
    });

    paint();
    return node;
  }

  /* ---------------- 练习回顾：查看某一次练习的错题 ---------------- */
  function viewReview() {
    var node = cloneTpl('tpl-list');
    var h = reviewH || {};
    $('#listTitle', node).textContent = '练习回顾';
    var desc = $('#listDesc', node);
    var body = $('#listBody', node);
    var d = new Date(h.at || Date.now());
    var dateStr = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    desc.textContent = h.label || ((h.pid && BY_ID[h.pid] ? BY_ID[h.pid].title : '混合练习') + ' · ' +
      (h.mod ? modLabel(h.mod) : '混合') + ' · ' + (h.mode === 'exam' ? '考试' : '练习') + ' · ' +
      dateStr + ' · 得分 ' + h.score + '/' + (h.total || 100) + ' · 用时 ' + fmtUsed(h.used || 0) +
      (h.random ? ' · 随机' : ''));
    var keys = wrongKeysOf(h);

    var ops = el('div', 'filter-row');
    var b1 = el('button', 'btn btn-sm btn-primary', '重练本次错题（' + keys.length + ' 道）');
    b1.addEventListener('click', function () {
      if (!keys.length) { toast('这次没有错题'); return; }
      beginSet(keys.map(function (k) { return QMAP[k]; }).filter(Boolean), '练习回顾 · 错题重练', 'practice');
    });
    var b2 = el('button', 'btn btn-sm btn-ghost', '← 返回错题本');
    b2.addEventListener('click', function () { route = 'wrong'; render(); });
    ops.appendChild(b1); ops.appendChild(b2);
    $('.panel', node).insertBefore(ops, body);

    if (!keys.length) {
      body.appendChild(el('div', 'empty', '这次练习全对，没有错题 🎉'));
      return node;
    }
    keys.forEach(function (k) {
      var q = QMAP[k];
      if (!q) return;
      var row = cloneTpl('tpl-row');
      var tag = $('.tag', row);
      tag.textContent = typeName(q.t);
      tag.className = typeTagClass(q.t);
      $('.qtext', row).textContent = q.pid + ' 卷 第 ' + q.n + ' 题 · ' + q.q;
      var c = correctOf(q);
      $('.qsub', row).textContent = c ? ('参考答案：' + c.split('').join(' ')) : '答案未收录';
      $('[data-act="row-go"]', row).textContent = '重练';
      $('[data-act="row-go"]', row).addEventListener('click', function () {
        beginSet([q], q.pid + ' 卷 第 ' + q.n + ' 题', 'practice');
      });
      $('[data-act="row-del"]', row).textContent = '移除';
      $('[data-act="row-del"]', row).addEventListener('click', function () {
        if (db.wrong[k]) { delete db.wrong[k]; save(); }
        toast('已移出错题本');
      });
      body.appendChild(row);
    });
    return node;
  }

  /* ---------------- history ---------------- */
  function viewHistory() {
    var node = cloneTpl('tpl-history');
    var list = $('#hisList', node);
    var items = db.history.slice().reverse();
    $('#hisDesc', node).textContent = '共 ' + items.length + ' 条记录，保存在本机浏览器；换浏览器或清缓存会丢，可先导出备份。';
    if (!items.length) list.appendChild(el('div', 'empty', '还没有记录，做一套卷子就会自动保存 🎯'));
    items.forEach(function (h) {
      var total = h.total || 100;
      var pct = total ? Math.round(h.score / total * 100) : 0;
      var row = cloneTpl('tpl-his-row');
      $('.his-score b', row).textContent = h.score + '/' + total;
      $('.his-score span', row).textContent = '得分';
      var d = new Date(h.at);
      var dateStr = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      $('.his-title', row).textContent = h.label || ((h.pid && BY_ID[h.pid] ? BY_ID[h.pid].title : '混合练习') +
        ' · ' + (h.mod ? modLabel(h.mod) : '混合') + ' · ' + (h.mode === 'exam' ? '考试' : '练习'));
      var meta = dateStr + ' · 用时 ' + fmtUsed(h.used || 0);
      if (h.random) meta += ' · 随机';
      if (!h.snap) meta += ' · 旧记录(改答案后不重算)';
      $('.his-meta', row).textContent = meta;
      var b = $('.his-pct', row);
      b.textContent = pct + '%';
      b.className = 'ans-badge ' + (pct >= 80 ? 'ok' : pct >= 60 ? 'mid' : 'bad') + ' his-pct';
      var rv = $('[data-act="his-review"]', row);
      if (h.snap) {
        rv.classList.remove('hidden');
        rv.textContent = '本次错题 ' + wrongKeysOf(h).length + ' 道 →';
        rv.addEventListener('click', function () { reviewH = h; route = 'review'; render(); });
      }
      list.appendChild(row);
    });
    $('[data-act="his-clear"]', node).addEventListener('click', function () {
      if (!db.history.length) { toast('还没有记录'); return; }
      showModal('清空学习记录？', '只清除这份记录列表，不影响各卷作答进度、错题本和收藏。', '清空', function () {
        db.history = []; save(); render(); toast('记录已清空');
      });
    });
    $('[data-act="his-export"]', node).addEventListener('click', function () {
      if (!db.history.length) { toast('还没有记录'); return; }
      var blob = new Blob([JSON.stringify(db.history, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '学习记录.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
    return node;
  }

  /* ---------------- 正确率统计（按题型 / 知识点） ---------------- */
  function statData() {
    var byType = { single: [0, 0], multi: [0, 0], judge: [0, 0] };
    var byKp = {};
    var wrongKs = {};
    db.history.forEach(function (h) {
      if (!h.snap) return;
      Object.keys(h.snap).forEach(function (k) {
        var q = QMAP[k];
        if (!q) return;
        var ok = h.snap[k] === correctOf(q);
        var c = byType[q.t]; c[0] += ok ? 1 : 0; c[1]++;
        if (q.kp) {
          var kc = byKp[q.kp] || (byKp[q.kp] = [0, 0]);
          kc[0] += ok ? 1 : 0; kc[1]++;
        }
        if (!ok) wrongKs[q.key] = true;
      });
    });
    return { byType: byType, byKp: byKp, wrongCount: Object.keys(wrongKs).length };
  }

  function statRowHtml(name, ok, total) {
    var pct = total ? Math.round(ok / total * 100) : 0;
    var color = pct >= 80 ? 'var(--ok)' : pct >= 60 ? '#d97706' : 'var(--bad)';
    return '<div class="stat-row"><span class="stat-name">' + escHtml(name) + '</span>' +
      '<span class="stat-bar"><i style="width:' + pct + '%;background:' + color + '"></i></span>' +
      '<b style="color:' + color + '">' + pct + '%</b>' +
      '<span class="stat-n">' + ok + '/' + total + ' 题</span></div>';
  }

  function viewStats() {
    var d = statData();
    var node = cloneTpl('tpl-panel-view');
    $('h2', node).textContent = '正确率统计';
    var totalN = d.byType.single[1] + d.byType.multi[1] + d.byType.judge[1];
    var okN = d.byType.single[0] + d.byType.multi[0] + d.byType.judge[0];
    $('.desc', node).innerHTML = '基于全部学习记录（含答题快照）按当前答案计算。累计作答 <b>' + totalN +
      '</b> 次，答对 <b>' + okN + '</b> 次，总体正确率 <b>' + (totalN ? Math.round(okN / totalN * 100) : 0) +
      '%</b>；涉及 <b>' + d.wrongCount + '</b> 道答错过的题（可在错题本重练）。';

    var box = $('#statsBody', node);

    /* ---- 最近 7 天：按天汇总学习记录里的作答量与正确率，柱形小图 ---- */
    var days = [];
    var day0 = new Date(); day0.setHours(0, 0, 0, 0);
    for (var di = 6; di >= 0; di--) {
      var s0 = day0.getTime() - di * 86400000;
      var dd = new Date(s0);
      days.push({
        start: s0, end: s0 + 86400000,
        label: di === 0 ? '今天' : (pad2(dd.getMonth() + 1) + '-' + pad2(dd.getDate())),
        n: 0, ok: 0
      });
    }
    var latestAt = 0;
    db.history.forEach(function (h) {
      if (!h.snap || !h.at) return;
      if (h.at > latestAt) latestAt = h.at;
      for (var j = 0; j < 7; j++) {
        if (h.at >= days[j].start && h.at < days[j].end) {
          var keys = Object.keys(h.snap);
          days[j].n += keys.length;
          keys.forEach(function (k) {
            var q = QMAP[k];
            if (q && h.snap[k] === correctOf(q)) days[j].ok++;
          });
          break;
        }
      }
    });
    box.appendChild(el('h3', null, '最近 7 天'));
    var weekN = days.reduce(function (a, d) { return a + d.n; }, 0);
    var weekOk = days.reduce(function (a, d) { return a + d.ok; }, 0);
    var maxN = Math.max.apply(null, days.map(function (d) { return d.n; }).concat([1]));
    var chart = '<div class="trend-chart">' + days.map(function (d) {
      var pct = d.n ? Math.round(d.ok / d.n * 100) : null;
      var color = pct == null ? 'var(--line)' : (pct >= 80 ? 'var(--ok)' : pct >= 60 ? '#d97706' : 'var(--bad)');
      var h = d.n ? Math.max(6, Math.round(d.n / maxN * 88)) : 0;
      return '<div class="trend-col" title="' + d.label + ' 作答 ' + d.n + ' 题' +
        (pct == null ? '' : '，正确率 ' + pct + '%') + '">' +
        '<span class="trend-val">' + (d.n || '') + '</span>' +
        '<i class="trend-bar" style="height:' + h + '%;background:' + (d.n ? color : 'var(--line)') + '"></i>' +
        '<span class="trend-lb">' + d.label + '</span></div>';
    }).join('') + '</div>';
    var trendWrap = el('div', 'stat-block');
    trendWrap.innerHTML = chart;
    box.appendChild(trendWrap);
    var trendSum = el('p', 'desc');
    trendSum.innerHTML = weekN
      ? '最近 7 天共作答 <b>' + weekN + '</b> 题，答对 <b>' + weekOk + '</b> 题，平均正确率 <b>' +
        Math.round(weekOk / weekN * 100) + '%</b>' +
        (latestAt ? '；最近一次作答：' + (function (d) {
          return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        })(new Date(latestAt)) : '') + '。'
      : '最近 7 天还没有作答记录，去练一组就会出现在这里。';
    box.appendChild(trendSum);

    box.appendChild(el('h3', null, '按题型'));
    var wrap = el('div', 'stat-block');
    wrap.innerHTML = [['single', '单选题'], ['multi', '多选题'], ['judge', '判断题']].map(function (x) {
      var c = d.byType[x[0]];
      return statRowHtml(x[1], c[0], c[1]);
    }).join('');
    box.appendChild(wrap);

    box.appendChild(el('h3', null, '按知识点（错误率高的在前）'));
    var kps = Object.keys(d.byKp).map(function (k) {
      return { name: k, ok: d.byKp[k][0], total: d.byKp[k][1] };
    }).filter(function (x) { return x.total >= 3; })
      .sort(function (a, b) { return (a.ok / a.total) - (b.ok / b.total) || b.total - a.total; });
    if (!kps.length) {
      box.appendChild(el('div', 'empty', '还没有足够的数据（作答几次后这里会显示各知识点的正确率）'));
    } else {
      var kwrap = el('div', 'stat-block');
      kwrap.innerHTML = kps.map(function (x) { return statRowHtml(x.name, x.ok, x.total); }).join('');
      box.appendChild(kwrap);
      var hint = el('p', 'desc', '共统计 ' + kps.length + ' 个知识点（至少作答 3 次才显示）。正确率低的知识点建议优先复习，可在「自定义题库训练」中针对练习。');
      hint.style.marginTop = '10px';
      box.appendChild(hint);
    }
    return node;
  }

  /* ---------------- key management ---------------- */
  function keyText(pid) {
    var p = BY_ID[pid];
    var lines = p.questions.map(function (q) {
      var c = correctOf(q);
      return q.n + ' ' + (c || '?');
    });
    return lines.join('\n');
  }

  function viewKey() {
    var dn = deviceName();
    var node = cloneTpl('tpl-key');
    var sel = $('#keyPaper', node);
    var ta = $('#keyText', node);
    $('#dbDevice', node).textContent = '本设备名称：' + dn + '（恢复别人的备份时，其中的错题会合并进本机错题本并标注来源）';

    // 动态生成卷别选项（单题库模式下只有一个「理论题库」）
    sel.innerHTML = '';
    PAPERS.forEach(function (p) {
      var op = document.createElement('option');
      op.value = p.id;
      op.textContent = p.title + '（' + p.questions.length + ' 题）';
      sel.appendChild(op);
    });

    function refresh() {
      var pid = sel.value;
      ta.value = keyText(pid);
      var ov = db.overrides[pid] || {};
      var n = Object.keys(ov).length;
      $('#keyStat', node).textContent = n ? ('本卷已修改 ' + n + ' 题') : '本卷使用默认答案';
    }
    sel.addEventListener('change', refresh);

    $('[data-act="key-load"]', node).addEventListener('click', refresh);
    $('[data-act="key-reset"]', node).addEventListener('click', function () {
      var pid = sel.value;
      showModal('恢复默认答案？', '将清除你在「' + (BY_ID[pid] ? BY_ID[pid].title : pid) + '」手动修改的答案。', '恢复', function () {
        delete db.overrides[pid]; save(); refresh(); toast('已恢复默认答案');
      });
    });
    $('[data-act="key-apply"]', node).addEventListener('click', function () {
      var pid = sel.value;
      var raw = ta.value.replace(/[，、；;]/g, '\n');
      var count = 0, bad = 0;
      var ov = db.overrides[pid] = db.overrides[pid] || {};
      var base = KEY[pid] || {};
      raw.split(/\r?\n/).forEach(function (line) {
        var t = line.trim();
        if (!t) return;
        var m = t.match(/^(\d{1,4})\s*[\.:：\-]?\s*([A-Ha-h]+)$/) || t.match(/^(\d{1,4})\s+([A-Ha-h\s]+)$/);
        if (!m) { bad++; return; }
        var no = parseInt(m[1], 10);
        var ans = sortedLetters(m[2].replace(/\s/g, ''));
        var p = BY_ID[pid];
        if (!p || !p.questions.some(function (q) { return q.n === no; })) { bad++; return; }
        if (!ans) { bad++; return; }
        if (ans === sortedLetters(base[no] || '')) delete ov[no];
        else { ov[no] = ans; count++; }
      });
      // 按新答案重算有快照的历史记录得分
      var rescored = 0;
      db.history.forEach(function (h) {
        if (!h.snap || h.pid !== pid) return;
        var ok = 0, total = 0;
        Object.keys(h.snap).forEach(function (k) {
          var m = /^(\w)#(\d+)$/.exec(k);
          if (!m || m[1] !== pid) return;
          total++;
          if (correctOf({ pid: pid, n: parseInt(m[2], 10) }) === h.snap[k]) ok++;
        });
        if (total) { h.score = ok; h.total = total; rescored++; }
      });
      save();
      $('#keyStat', node).textContent = '本卷已修改 ' + Object.keys(ov).length + ' 题';
      toast('已更新 ' + count + ' 题' + (bad ? '，' + bad + ' 行无法识别' : '') + (rescored ? '，已重算 ' + rescored + ' 条历史成绩' : ''));
      if (lastResult && route === 'result') render();
    });
    $('[data-act="key-export"]', node).addEventListener('click', function () {
      var out = {};
      PAPERS.forEach(function (p) {
        out[p.id] = {};
        p.questions.forEach(function (q) { out[p.id][q.n] = correctOf(q); });
      });
      var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '答案导出.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
    $('[data-act="db-export"]', node).addEventListener('click', exportAllBackup);
    $('[data-act="db-import"]', node).addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        var rd = new FileReader();
        rd.onload = function () {
          var data;
          try { data = JSON.parse(String(rd.result)); } catch (e) { toast('文件解析失败，请检查 JSON 格式'); return; }
          if (!data || typeof data !== 'object') { toast('这不是有效的进度备份文件'); return; }
          /* v3.7 外壳格式（backupVer:2）；兼容旧版裸 db 备份 */
          var pack = (data.backupVer === 2 && data.db && typeof data.db === 'object')
            ? data : { deviceName: '', exportedAt: 0, db: data };
          var d = pack.db || {};
          if (!d.papers || !d.history) { toast('这不是有效的进度备份文件'); return; }
          var srcName = pack.deviceName || '备份文件';
          /* 恢复前先给用户看清这份备份是谁、什么时候导的、里面有什么，防止拿旧备份覆盖新进度 */
          function relWhen(t) {
            var d = new Date(t);
            var base = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
            var diff = Date.now() - t;
            if (diff < 0) return base;
            if (diff < 3600e3) return Math.max(1, Math.round(diff / 60e3)) + ' 分钟前（' + base + '）';
            if (diff < 86400e3) return Math.round(diff / 3600e3) + ' 小时前（' + base + '）';
            return Math.round(diff / 86400e3) + ' 天前（' + base + '）';
          }
          var whenTxt = pack.exportedAt ? relWhen(pack.exportedAt) : '未知（旧版备份未带导出时间）';
          var wN = Object.keys(d.wrong || {}).length;
          var fN = Object.keys(d.fav || {}).length;
          var nN = Object.keys(d.notes || {}).filter(function (k) {
            var e = d.notes[k]; return e && (e.t || (e.o && Object.keys(e.o).length));
          }).length;
          var hasUndoneBk = !!((d.temp && Object.keys(d.temp.answers || {}).length) ||
            Object.keys(d.papers || {}).some(function (pid) {
              var p = d.papers[pid];
              return p && p.sessions && Object.keys(p.sessions).some(function (m) {
                var ms = p.sessions[m];
                return ms && !ms.done && ms.order && Object.keys(ms.answers || {}).length;
              });
            }));
          var localNew = 0;
          db.history.forEach(function (h) { if (h.at > localNew) localNew = h.at; });
          var staleWarn = (pack.exportedAt && localNew > pack.exportedAt)
            ? '<b style="color:#c0392b">注意：本机已有比这份备份更新的作答记录（最近一次 ' + relWhen(localNew) +
              '），恢复会把这些更新内容覆盖掉。</b><br>' : '';
          showModal('恢复备份？',
            '来自「<b>' + escHtml(srcName) + '</b>」的备份，导出于 ' + escHtml(whenTxt) + '。<br>' +
            '内容：学习记录 ' + (d.history || []).length + ' 条、错题 ' + wN + ' 道、收藏 ' + fN +
            ' 题、笔记 ' + nN + ' 条' + (hasUndoneBk ? '、含未交卷进度' : '') + '。<br>' + staleWarn +
            '作答进度、收藏、历史记录、答案修改将覆盖为备份内容；' +
            '错题本为<b>合并</b>：备份里的错题逐道加入（标记为来自「' + escHtml(srcName) + '」的备份错题），当前已有错题全部保留、不覆盖。' +
            '笔记同样<b>合并</b>：同一题以备份里的笔记为准，本机其他笔记保留。',
            '合并恢复', function () {
              var curName = deviceName();
              var added = 0;
              var bw = d.wrong || {};
              Object.keys(bw).forEach(function (k) {
                if (!db.wrong[k]) {
                  var e = bw[k] || {};
                  db.wrong[k] = { pid: e.pid, n: e.n, at: e.at || Date.now(), src: srcName, srcAt: pack.exportedAt || 0 };
                  added++;
                }
              });
              var st = d.settings || {};
              st.deviceName = curName; /* 设备身份保持本机的，不跟备份走 */
              /* 笔记合并：备份里有的题以备份内容为准，本机独有（备份里没有）的笔记保留 */
              var mergedNotes = db.notes || {};
              var noteIn = 0;
              Object.keys(d.notes || {}).forEach(function (k) {
                var e = d.notes[k];
                if (!e || !e.t) return;
                if (!mergedNotes[k]) noteIn++;
                mergedNotes[k] = e;
              });
              db = {
                papers: d.papers || {}, wrong: db.wrong, fav: d.fav || {},
                notes: mergedNotes,
                overrides: d.overrides || {}, history: d.history || [], settings: st
              };
              if (d.temp) db.temp = d.temp;
              memOnly = false;
              save();
              lastResult = null;
              route = 'home';
              render();
              var hasUndone = false;
              Object.keys(db.papers).forEach(function (pid) {
                var st2 = db.papers[pid];
                if (st2.sessions) Object.keys(st2.sessions).forEach(function (m) {
                  var ms = st2.sessions[m];
                  if (ms && !ms.done && ms.order && Object.keys(st2.answers || {}).length) hasUndone = true;
                });
              });
              if (db.temp && Object.keys(db.temp.answers || {}).length) hasUndone = true;
              toast('进度已恢复（' + db.history.length + ' 条学习记录' +
                (hasUndone ? '，含未交卷进度，回首页点「继续」接着答' : '') +
                '），错题合并新增 ' + added + ' 道（来自「' + srcName + '」）' +
                (noteIn ? '，笔记新增 ' + noteIn + ' 条' : '') + '，当前共 ' + noteCount() + ' 条笔记');
            });
        };
        rd.readAsText(f, 'utf-8');
      });
      inp.click();
    });
    $('[data-act="key-reset-all"]', node).addEventListener('click', function () {
      showModal('重置全部进度？', '将清空题库的作答记录、错题本、收藏、笔记与历史成绩（答案修改也会清除）。', '全部清空', function () {
        db.papers = {}; db.wrong = {}; db.fav = {}; db.notes = {}; db.history = []; db.overrides = {};
        save(); lastResult = null; refresh(); toast('已重置');
      });
    });
    $('[data-act="key-import"]', node).addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        var rd = new FileReader();
        rd.onload = function () {
          try {
            var data = JSON.parse(String(rd.result));
            var n = 0;
            Object.keys(data).forEach(function (pid) {
              if (!BY_ID[pid]) return;
              db.overrides[pid] = db.overrides[pid] || {};
              Object.keys(data[pid]).forEach(function (no) {
                var ans = sortedLetters(String(data[pid][no]));
                if (ans) { db.overrides[pid][no] = ans; n++; }
              });
            });
            save(); refresh(); toast('已导入 ' + n + ' 条答案');
          } catch (e) { toast('文件解析失败，请检查 JSON 格式'); }
        };
        rd.readAsText(f, 'utf-8');
      });
      inp.click();
    });

    refresh();
    return node;
  }

  /* ---------------- keyboard ---------------- */
  document.addEventListener('keydown', function (e) {
    if (route !== 'quiz' || !sess) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    /* Ctrl/Alt/Win+字母是系统与浏览器快捷键（复制、收藏等），不拦截 */
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    /* 弹窗（交卷确认、三选弹窗等）打开时不响应选项快捷键 */
    if ($('.modal-mask')) return;
    var k = String(e.key || '').toUpperCase();
    /* v3.11.3 数字键 1–9 选选项：多选题按同一个数字＝取消勾选该选项（走 choose 的 pending 切换），
       按到不存在的选项序号直接忽略——不 preventDefault、不弹提示，等于没按 */
    if (k.length === 1 && k >= '1' && k <= '9') {
      var qi = k.charCodeAt(0) - 49;
      var qd = cur();
      if (qi >= qd.o.length) return;   /* 没有这个选项：无反应 */
      e.preventDefault();
      var dbts = $all('#qOpts .opt');
      if (dbts[qi]) dbts[qi].click();
    } else if (k.length === 1 && 'ABCDEFGH'.indexOf(k) >= 0) {
      var q = cur();
      var i = 'ABCDEFGH'.indexOf(k);
      if (i < q.o.length) {
        e.preventDefault();
        var btns = $all('#qOpts .opt');
        if (btns[i]) btns[i].click();
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      var nb = $('[data-act="next"]');
      if (nb) nb.click();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      var pb = $('[data-act="prev"]');
      if (pb) pb.click();
    } else if (e.key === 'Enter') {
      if ($('.modal-mask')) return;
      /* 多选题勾完按回车＝「确认作答」；其余情况回车仍是交卷确认 */
      var cm = $('[data-act="confirm-multi"]');
      e.preventDefault();
      if (cm && !cm.classList.contains('hidden')) { cm.click(); return; }
      confirmSubmit();
    }
  });

  /* ---------------- top nav ---------------- */
  $all('.top-link').forEach(function (b) {
    b.addEventListener('click', function () {
      var nav = b.getAttribute('data-nav');
      if (nav === 'home') {
        if (route === 'quiz' && sess && Object.keys(sess.answers).length && !sess.done) {
          showModal('回到首页？', '本次作答进度会保存，稍后可继续。', '回到首页', function () {
            persistPos(); sess = null; route = 'home'; render();
          }, '继续答题');
          return;
        }
        sess = null;
        route = 'home';
      } else if (nav === 'wrong') { route = 'wrong'; }
      else if (nav === 'notes') { route = 'notes'; }
      else if (nav === 'key') { route = 'key'; }
      render();
    });
  });

  document.addEventListener('click', function (e) {
    var side = document.getElementById('sideCard');
    if (!side || !side.classList.contains('open')) return;
    if (side.contains(e.target)) return;
    if (e.target.closest && e.target.closest('[data-act="toggle-card"]')) return;
    side.classList.remove('open');
  });

  window.addEventListener('beforeunload', function () { if (sess) persistPos(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && sess) persistPos();
  });

  /* ---------------- boot ---------------- */
  applyLayoutAttr();
  if (!PAPERS.length) {
    app.appendChild(el('div', 'empty', '题库数据未加载，请检查 data/questions.js 是否存在'));
  } else {
    render();
  }
})();
