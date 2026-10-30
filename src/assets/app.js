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
  var TYPES = ['single', 'multi', 'judge'];
  PAPERS.forEach(function (p) {
    BY_ID[p.id] = p;
    p.questions.forEach(function (q) {
      q.pid = p.id;
      q.key = p.id + '#' + q.n;
      ALL.push(q);
      QMAP[q.key] = q;
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
    catch (e) { memOnly = true; }
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
    return p.questions.filter(function (q) { return q.t === mod; });
  }

  function modLabel(mod) {
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
  var lastResult = null;
  var revOnlyWrong = false;
  var tickTimer = null;
  var reviewH = null;

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

  function beginSet(qs, title, mode, random, persistOpt) {
    if (random) shuffle(qs);
    sess = {
      pid: null, mod: null, title: title, mode: mode, qs: qs,
      answers: {}, flags: {}, idx: 0, st: null, ms: null,
      persist: !!persistOpt, startAt: Date.now(), pending: {},
      deadline: mode === 'exam' ? Date.now() + Math.max(600, qs.length * 54) * 1000 : 0,
      limit: Math.max(600, qs.length * 54), done: false,
      random: !!random
    };
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
    if (sess && sess.persist && sess.ms) { sess.ms.idx = sess.idx; sess.ms.at = Date.now(); save(); }
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
    else if (route === 'review') node = viewReview();
    else if (route === 'history') node = viewHistory();
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
  }

  /* ---------------- home ---------------- */
  function viewHome() {
    var node = cloneTpl('tpl-home');
    var grid = $('#paperGrid', node);
    var mini = $('#miniGrid', node);

    PAPERS.forEach(function (p) {
      var card = cloneTpl('tpl-paper-card');
      var s = db.papers[p.id] ? pstate(p.id) : null;
      $('.p-title', card).textContent = p.title;
      $('.p-meta', card).textContent = p.questions.length + ' 题 · 满分 100';
      var doneCount = s ? Object.keys(s.answers).length : 0;
      var best = null;
      db.history.forEach(function (h) {
        if (h.pid === p.id && (!h.mod || h.mod === 'all') && (h.total || 100) === 100 && (best === null || h.score > best)) best = h.score;
      });
      $('.p-score', card).textContent = best === null ? '—' : String(best);
      $('.p-done', card).textContent = String(doneCount);

      var resume = $('.p-resume', card);
      var recent = null, recentMod = null;
      if (s && s.sessions) {
        Object.keys(s.sessions).forEach(function (mod) {
          var ms = s.sessions[mod];
          if (!ms || ms.done || !ms.order) return;
          if (!moduleAnswered(p.id, mod)) return;
          if (!recent || (ms.at || 0) > (recent.at || 0)) { recent = ms; recentMod = mod; }
        });
      }
      if (recent) {
        resume.classList.remove('hidden');
        resume.textContent = '继续：' + modLabel(recentMod) + ' · ' + (recent.mode === 'practice' ? '练习' : '考试') +
          ' · ' + (recent.random ? '随机' : '顺序') + ' · ' + moduleAnswered(p.id, recentMod) + '/' + (recent.total || 0);
        resume.addEventListener('click', function () { beginSession(p.id, recentMod, recent.mode || 'exam', {}); });
      }
      function startAll(mode) {
        var st = pstate(p.id);
        if (Object.keys(st.answers).length === 0) {
          beginSession(p.id, 'all', mode, { fresh: true, random: false });
          return;
        }
        showModal('本卷已有作答记录', '可以「继续做」保留本卷已答接着做，或「清空并开始」清空本卷全部已答答案与标记后重新做（错题本、收藏、历史成绩保留）。',
          '清空并开始', function () {
            clearPaperAnswers(p.id);
            beginSession(p.id, 'all', mode, { fresh: true, random: false });
          }, '取消', null,
          { text: '继续做', onClick: function () {
              var ms = st.sessions.all;
              if (ms && ms.order && !ms.done) beginSession(p.id, 'all', mode, {});
              else beginSession(p.id, 'all', mode, { fresh: true, random: false });
            } });
      }
      $('.btn-primary', card).addEventListener('click', function () { startAll('exam'); });
      $('[data-act="card-practice"]', card).addEventListener('click', function () { startAll('practice'); });
      $('[data-act="card-modules"]', card).addEventListener('click', function () { openPaper(p.id, pick.mode); });
      grid.appendChild(card);
    });

    function miniCard(icon, cls, title, sub, fn) {
      var c = el('div', 'mini-card');
      c.appendChild(el('div', 'ico ' + cls, icon));
      var box = el('div');
      box.appendChild(el('h4', null, title));
      box.appendChild(el('p', null, sub));
      c.appendChild(box);
      c.addEventListener('click', fn);
      return c;
    }
    mini.appendChild(miniCard('🎲', '', '全库随机练习', '全库 ' + ALL.length + ' 题随机 · 不限时练完', function () {
      startRandomExam();
    }));
    mini.appendChild(miniCard('📕', 'warn', '错题重练', '已收录 ' + Object.keys(db.wrong).length + ' 道错题', function () {
      route = 'wrong'; render();
    }));
    mini.appendChild(miniCard('⭐', 'ok', '我的收藏', '已收藏 ' + Object.keys(db.fav).length + ' 道题', function () {
      route = 'fav'; render();
    }));
    mini.appendChild(miniCard('🗂️', '', '学习记录', '已保存 ' + db.history.length + ' 次作答记录', function () {
      route = 'history'; render();
    }));

    var heroBtn = $('[data-act="random-exam"]', node);
    if (heroBtn) heroBtn.textContent = '全库随机练习（' + ALL.length + ' 题）';

    var kpis = $('#homeKpis', node);
    var answered = 0;
    PAPERS.forEach(function (p) { var s = db.papers[p.id]; if (s) answered += Object.keys(s.answers).length; });
    var avg = null;
    if (db.history.length) {
      var sum = 0, cnt = 0;
      db.history.forEach(function (h) { sum += h.score / (h.total || 100) * 100; cnt++; });
      avg = Math.round(sum / cnt);
    }
    [['题库总量', ALL.length + ' 题'], ['累计作答', answered + ' 题'], ['历史平均分', avg === null ? '—' : avg], ['错题数量', Object.keys(db.wrong).length + ' 题']].forEach(function (x) {
      var k = cloneTpl('tpl-kpi');
      $('span', k).textContent = x[0];
      $('b', k).textContent = x[1];
      kpis.appendChild(k);
    });

    $('[data-act="random-exam"]', node).addEventListener('click', function () { startRandomExam(); });
    $('[data-act="open-wrong"]', node).addEventListener('click', function () { route = 'wrong'; render(); });
    $('[data-act="open-history"]', node).addEventListener('click', function () { route = 'history'; render(); });
    return node;
  }

  function startRandomExam() {
    var picks = shuffle(ALL.slice()).map(function (q) {
      return { pid: q.pid, n: q.n, key: q.key, t: q.t, q: q.q, o: q.o };
    });
    beginSet(picks, '全库随机练习（' + ALL.length + ' 题）', 'practice', false, true);
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
    $('#qModeTag', node).textContent = sess.mode === 'exam' ? '考试模式' : '练习模式';
    var btnOrder = $('#btnOrder', node);
    if (btnOrder) {
      btnOrder.textContent = sess.random ? '随机' : '顺序';
      btnOrder.classList.toggle('on', !!sess.random);
      btnOrder.title = sess.random ? '当前随机出题，点击改为顺序' : '当前按题号顺序，点击改为随机';
      btnOrder.addEventListener('click', function () { applyOrder(!sess.random); });
    }

    var opts = $('#qOpts', node);
    var cells = $('#cards', node);

    function rebuildQuestion() {
      var q = cur();
      // 跳转栏：当前题型按钮高亮
      $all('.jt', node).forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-type') === q.t);
      });
      opts.innerHTML = '';
      q.o.forEach(function (txt, i) {
        var o = cloneTpl('tpl-option');
        o.setAttribute('data-letter', letterAt(i));
        $('.letter', o).textContent = letterAt(i);
        $('.txt', o).textContent = txt;
        o.addEventListener('click', function () { choose(i); });
        opts.appendChild(o);
      });
      $('#qNo', node).textContent = '第 ' + (sess.idx + 1) + ' / ' + sess.qs.length + ' 题';
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
      tick();
    }

    // build answer card once —— 按题型固定分组（单选→多选→判断），cell 用 data-idx 对应题序
    var buckets = { single: [], multi: [], judge: [] };
    sess.qs.forEach(function (q, i) { buckets[q.t].push(i); });
    ['single', 'multi', 'judge'].forEach(function (t) {
      if (!buckets[t].length) return;
      cells.appendChild(el('div', 'card-sep', typeName(t)));
      var group = el('div', 'card-group');
      buckets[t].forEach(function (i) {
        var c = cloneTpl('tpl-cell');
        c.textContent = String(sess.qs[i].n);
        c.setAttribute('data-idx', String(i));
        c.addEventListener('click', function () {
          sess.idx = i; persistPos();
          rebuildQuestion();
          var side = $('#sideCard', node);
          if (side) side.classList.remove('open');
        });
        group.appendChild(c);
      });
      cells.appendChild(group);
    });

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

    function choose(i) {
      var q = cur();
      var L = letterAt(i);
      if (q.t === 'multi') {
        var next = pendingOf(q);
        next = next.indexOf(L) >= 0 ? next.replace(L, '') : sortedLetters(next + L);
        if (sess.mode === 'practice' && sess.answers[q.key]) { toast('本题已作答，可「清空本题」后重选'); return; }
        sess.pending[q.key] = next;
        if (sess.mode === 'exam') {
          setAnswer(q, next);
        }
        paintOptions();
        paintCard();
        return;
      }
      if (sess.mode === 'practice' && sess.answers[q.key]) { toast('本题已作答，可「清空本题」后重选'); return; }
      setAnswer(q, L);
      if (sess.mode === 'practice') {
        var c = correctOf(q);
        if (c && L === c) {
          removeWrong(q);
          if (autoNext()) return; // 答对自动下一题
        } else if (c) { addWrong(q); }
      }
      paintOptions();
      paintCard();
      paintFeedback();
    }

    function setAnswer(q, v) {
      if (v) sess.answers[q.key] = sortedLetters(v);
      else delete sess.answers[q.key];
      if (sess.persist) save();
    }

    function paintOptions() {
      var q = cur();
      var a = sess.answers[q.key] || '';
      var c = correctOf(q);
      var showKey = sess.mode === 'practice' && !!a;
      var pending = (sess.mode === 'practice' && q.t === 'multi') ? pendingOf(q) : a;
      $all('.opt', opts).forEach(function (o) {
        var L = o.getAttribute('data-letter');
        var sel = (sess.mode === 'practice' && q.t === 'multi' && !a ? pending : a).indexOf(L) >= 0;
        o.classList.toggle('sel', sel);
        o.classList.toggle('correct', showKey && c.indexOf(L) >= 0);
        o.classList.toggle('wrong', showKey && sel && c.indexOf(L) < 0);
        var mk = $('.mark', o);
        if (showKey && c.indexOf(L) >= 0) mk.textContent = '正确答案';
        else if (showKey && sel) mk.textContent = '你的选择';
        else mk.textContent = '';
      });
      var b = $('[data-act="confirm-multi"]', node);
      var needConfirm = sess.mode === 'practice' && q.t === 'multi' && !sess.answers[q.key];
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
      var cellsArr = $all('.cell', cells);
      var byIdx = {};
      cellsArr.forEach(function (c) { byIdx[parseInt(c.getAttribute('data-idx'), 10)] = c; });
      var done = 0, flag = 0;
      sess.qs.forEach(function (q, i) {
        var cell = byIdx[i];
        if (!cell) return;
        var d = !!sess.answers[q.key];
        if (d) done++;
        if (sess.flags[q.key]) flag++;
        cell.classList.toggle('done', d);
        cell.classList.toggle('flag', !!sess.flags[q.key]);
        cell.classList.toggle('cur', i === sess.idx);
      });
      $('#infoDone', node).textContent = String(done);
      $('#infoFlag', node).textContent = String(flag);
      $('#infoLeft', node).textContent = String(sess.qs.length - done);
      $('#cardProgress', node).textContent = done + '/' + sess.qs.length;
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
      paintOptions(); paintCard(); paintFeedback();
    });
    $('[data-act="fav"]', node).addEventListener('click', function () {
      var q = cur();
      if (db.fav[q.key]) delete db.fav[q.key];
      else db.fav[q.key] = { pid: q.pid, n: q.n, at: Date.now() };
      save(); rebuildQuestion();
    });
    $('[data-act="confirm-multi"]', node).addEventListener('click', function () {
      var q = cur();
      var v = pendingOf(q);
      if (!v) { toast('请先选择至少一个选项'); return; }
      setAnswer(q, v);
      var c = correctOf(q);
      if (c && v === c) {
        removeWrong(q);
        if (autoNext()) return; // 多选确认后答对自动下一题
      } else if (c) { addWrong(q); }
      paintOptions(); paintCard(); paintFeedback();
    });
    $('[data-act="toggle-card"]', node).addEventListener('click', function () {
      $('#sideCard', node).classList.toggle('open');
    });
    // 跳转栏：一键切换题型（跳到该题型在本组题中的第一题）
    $all('[data-act="jump-type"]', node).forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-type');
        var i = sess.qs.findIndex(function (x) { return x.t === t; });
        if (i < 0) { toast('本次练习中没有' + typeLabel(t)); return; }
        sess.idx = i; persistPos(); rebuildQuestion();
      });
    });
    // 跳转栏：按题号跳转（按题库题号找，随机顺序下也能定位）
    $('[data-act="jump-no"]', node).addEventListener('click', function () {
      var inp = $('#jumpNo', node);
      var no = parseInt(inp.value, 10);
      if (!no) { toast('请输入题号'); return; }
      var i = sess.qs.findIndex(function (x) { return x.n === no; });
      if (i < 0) { toast('本次练习中没有第 ' + no + ' 题'); return; }
      sess.idx = i; persistPos(); rebuildQuestion();
      inp.value = '';
    });
    $('#jumpNo', node).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('[data-act="jump-no"]', node).click(); }
    });
    $('[data-act="submit"]', node).addEventListener('click', function () { confirmSubmit(); });
    $('[data-act="exit"]', node).addEventListener('click', function () {
      var answered = Object.keys(sess.answers).length;
      var pid = sess.pid, mode = sess.mode;
      function leave() {
        persistPos();
        sess = null;
        if (pid) { pick.pid = pid; pick.mode = mode; route = 'paper'; }
        else route = 'home';
        render();
      }
      if (answered && !sess.done) {
        showModal('暂时离开？', '作答进度会保存，下次点「继续」接着做。', '离开', leave, '继续答题');
      } else leave();
    });

    rebuildQuestion();
    return node;
  }

  function confirmSubmit() {
    var unanswered = sess.qs.filter(function (q) { return !sess.answers[q.key]; }).length;
    var msg = '共 ' + sess.qs.length + ' 题，已答 ' + (sess.qs.length - unanswered) + ' 题';
    if (unanswered) msg += '，还有 ' + unanswered + ' 题未作答（按错处理）';
    msg += '。交卷后即可查看答案与解析。';
    showModal('确认交卷？', msg, '交卷', function () { evaluateAndFinish(false); });
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
        at: Date.now(), used: Math.round(used), random: !!s.random, snap: snap
      });
      if (db.history.length > 200) db.history = db.history.slice(-200);
      save();
    }
    lastResult = { sess: s, r: r, used: used };
    revOnlyWrong = false;
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
    function paintReview() {
      revBox.innerHTML = '';
      var list = s.qs.filter(function (q) {
        if (!revOnlyWrong) return true;
        var c = correctOf(q), a = s.answers[q.key] || '';
        return !c || a !== c;
      });
      if (!list.length) { revBox.appendChild(el('div', 'empty', '没有需要回顾的题目 🎉')); return; }
      list.forEach(function (q) {
        var item = cloneTpl('tpl-review');
        var c = correctOf(q), a = s.answers[q.key] || '';
        var ok = c && a === c;
        item.classList.toggle('bad', !ok);
        $('.no', item).textContent = PAPERS.length > 1 ? (q.pid + ' 卷 第 ' + q.n + ' 题') : ('第 ' + q.n + ' 题');
        var tag = $('.tag', item);
        tag.textContent = typeName(q.t);
        tag.className = typeTagClass(q.t);
        var badge = el('span', 'ans-badge ' + (ok ? 'ok' : (c ? 'bad' : 'mid')), ok ? '答对' : (c ? (a ? '答错' : '未作答') : '未收录答案'));
        $('.badge-wrap', item).appendChild(badge);
        $('.rs', item).textContent = q.q;
        $('.ro-my span', item).textContent = a ? a.split('').join(' ') : '未作答';
        $('.ro-ck span', item).textContent = c ? c.split('').join(' ') : '—';
        if (q.an) item.appendChild(el('p', 'r-an', '📖 解析：' + q.an));
        revBox.appendChild(item);
      });
      toggle.textContent = revOnlyWrong ? '显示全部' : '只看错题';
    }
    paintReview();
    toggle.addEventListener('click', function () { revOnlyWrong = !revOnlyWrong; paintReview(); });

    $('[data-act="retry"]', node).addEventListener('click', function () {
      if (s.persist && s.pid) redoModule(s.pid, s.mod || 'all', s.mode, s.random);
      else beginSet(s.qs.map(function (q) { return q; }), s.title, s.mode, s.random);
    });
    $('[data-act="to-paper"]', node).addEventListener('click', function () {
      if (s.pid) { pick.pid = s.pid; pick.mode = s.mode; route = 'paper'; render(); }
      else { route = 'home'; render(); }
    });
    $('[data-act="to-wrong"]', node).addEventListener('click', function () { route = 'wrong'; render(); });
    $('[data-act="home"]', node).addEventListener('click', function () { route = 'home'; render(); });
    return node;
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

    function allQs() {
      return Object.keys(map).sort(function (a, b) { return (map[b].at || 0) - (map[a].at || 0); })
        .map(function (k) { return ALL.filter(function (x) { return x.key === k; })[0]; })
        .filter(Boolean);
    }
    function visibleQs() {
      var arr = allQs();
      if (filter !== 'all') arr = arr.filter(function (q) { return q.t === filter; });
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
        left.appendChild(el('div', 'qtext', (h.pid && BY_ID[h.pid] ? BY_ID[h.pid].title : '混合练习') +
          ' · ' + (h.mod ? modLabel(h.mod) : '混合') + ' · ' + (h.mode === 'exam' ? '考试' : '练习')));
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
      desc.textContent = kind === 'wrong'
        ? '共 ' + allQs().length + ' 道。答对后会自动移出；也可手动移除。每次交卷的错题可在上方「练习回顾」按次查看。'
        : '共 ' + allQs().length + ' 道。收藏的题目可以随时回看。';
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
        $('.qtext', row).textContent = q.pid + ' 卷 第 ' + q.n + ' 题 · ' + q.q;
        var c = correctOf(q);
        $('.qsub', row).textContent = c ? ('参考答案：' + c.split('').join(' ')) : '答案未收录';
        $('[data-act="row-go"]', row).addEventListener('click', function () {
          beginSet([q], q.pid + ' 卷 第 ' + q.n + ' 题', 'practice');
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
        paint();
      });
      tRev.addEventListener('click', function () {
        reviewMode = true;
        tRev.classList.add('on'); tCur.classList.remove('on');
        filterRow.style.display = 'none';
        paint();
      });
      tabRow.appendChild(tCur); tabRow.appendChild(tRev);
      $('.panel', node).insertBefore(tabRow, filterRow);
    }

    $('[data-act="list-practice"]', node).addEventListener('click', function () {
      var qs = visibleQs();
      if (!qs.length) { toast('列表是空的'); return; }
      beginSet(qs, title + ' · 重练', 'practice');
    });
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
    desc.textContent = (h.pid && BY_ID[h.pid] ? BY_ID[h.pid].title : '混合练习') + ' · ' +
      (h.mod ? modLabel(h.mod) : '混合') + ' · ' + (h.mode === 'exam' ? '考试' : '练习') + ' · ' +
      dateStr + ' · 得分 ' + h.score + '/' + (h.total || 100) + ' · 用时 ' + fmtUsed(h.used || 0) +
      (h.random ? ' · 随机' : '');
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
      $('.his-title', row).textContent = (h.pid && BY_ID[h.pid] ? BY_ID[h.pid].title : '混合练习') +
        ' · ' + (h.mod ? modLabel(h.mod) : '混合') + ' · ' + (h.mode === 'exam' ? '考试' : '练习');
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
    var node = cloneTpl('tpl-key');
    var sel = $('#keyPaper', node);
    var ta = $('#keyText', node);

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
    $('[data-act="key-reset-all"]', node).addEventListener('click', function () {
      showModal('重置全部进度？', '将清空题库的作答记录、错题本、收藏与历史成绩（答案修改也会清除）。', '全部清空', function () {
        db.papers = {}; db.wrong = {}; db.fav = {}; db.history = []; db.overrides = {};
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
    var k = String(e.key || '').toUpperCase();
    if (k.length === 1 && '1234'.indexOf(k) >= 0) {
      var q0 = cur();
      var i0 = '1234'.indexOf(k);
      if (i0 < q0.o.length) {
        e.preventDefault();
        var bts = $all('#qOpts .opt');
        if (bts[i0]) bts[i0].click();
      }
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
      e.preventDefault();
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
  if (!PAPERS.length) {
    app.appendChild(el('div', 'empty', '题库数据未加载，请检查 data/questions.js 是否存在'));
  } else {
    render();
  }
})();
