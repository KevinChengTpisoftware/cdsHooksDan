(function() {
  'use strict';

  // ===== State =====
  var serverUrl = '';
  var accessToken = '';
  var smartToken = '';
  var launchPatientId = '';
  var currentPatientId = '';
  var allPatients = [];
  var runId = '';
  var cdsServices = {};
  var visitOpen = false;
  var tickTimer = null;
  var renderedCards = {};
  var draftCounter = 0;
  var drafts = [];
  var danmakuCount = 0;
  var cardQueue = [];
  var cardQueueTimer = null;
  var dismissedCards = [];
  var currentFilter = 'all';
  var dmSettings = { size: 120, speed: 15, opacity: 100, enabled: true };

  // ===== Init =====
  window.onload = function() {
    buildMenus();
    var ps = new URLSearchParams(location.search);
    var isCallback = sessionStorage.getItem('ehr_launched') || ps.has('code') || ps.has('state');
    if (!isCallback) { location.href = 'index.html'; return; }
    sessionStorage.removeItem('ehr_launched');

    runId = sessionStorage.getItem('runId') || crypto.randomUUID();
    sessionStorage.setItem('runId', runId);

    extractIdentity(function() {
      acquireToken(function() {
        renderDoctorCard();
        cdsDiscovery(function() {
          fireHook('login', {});
          loadPatients();
        });
      });
    });
  };

  // ===== Identity =====
  function extractIdentity(cb) {
    try {
      FHIR.oauth2.ready().then(function(cl) {
        serverUrl = cl.state.serverUrl || '';
        if (cl.patient && cl.patient.id) {
          launchPatientId = cl.patient.id;
          sessionStorage.setItem('launchPid', launchPatientId);
        }
        var tr = cl.state.tokenResponse || {};
        if (tr.access_token) smartToken = tr.access_token;
        var idt = tr.id_token;
        if (idt) {
          var u = decodeJwt(idt);
          showUser(u.name || u.preferred_username || u.sub || '', u.email || '');
        }
        cb();
      }).catch(function() { cb(); });
    } catch(e) { cb(); }
  }

  function decodeJwt(token) {
    var b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b); var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function showUser(name, email) {
    sessionStorage.setItem('uname', name);
    sessionStorage.setItem('uemail', email);
    document.getElementById('userArea').hidden = false;
    document.getElementById('userName').textContent = name;
    renderDoctorCard();
  }

  // ===== Token =====
  function acquireToken(cb) {
    var cid = sessionStorage.getItem('cfgC') || CFG.CLIENT_ID;
    var basicAuth = btoa(cid + ':' + btoa(CFG.CLIENT_SECRET));
    fetch(CFG.BASE + '/dgrv4/ssotoken/smart/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + basicAuth },
      body: 'grant_type=client_credentials'
    }).then(function(r) { return r.json(); }).then(function(tok) {
      if (!tok.access_token) throw new Error('No token');
      accessToken = tok.access_token;
      if (!serverUrl) serverUrl = CFG.BASE + '/smart-on-fhir/digiCare/fhir';
      if (!launchPatientId) launchPatientId = sessionStorage.getItem('launchPid') || sessionStorage.getItem('cfgP') || CFG.DEFAULT_PATIENT;
      cb();
    }).catch(function(e) {
      document.getElementById('patientList').innerHTML = '<div class="loading-center"><p style="color:var(--accent-crit)">Token error: ' + e.message + '</p></div>';
    });
  }

  // ===== CDS Discovery =====
  function cdsDiscovery(cb) {
    var url = CFG.CDS_BASE + '/cds-hooks/' + CFG.CDS_PROXY + '/cds-services';
    var hdrs = {};
    if (smartToken) hdrs['Authorization'] = 'Bearer ' + smartToken;
    fetch(url, {headers: hdrs}).then(function(r) { return r.json(); }).then(function(data) {
      cdsServices = {};
      (data.services || []).forEach(function(s) {
        if (!cdsServices[s.hook]) cdsServices[s.hook] = [];
        cdsServices[s.hook].push(s);
      });
      console.log('[CDS] Discovered', Object.keys(cdsServices).map(function(k) { return k + ':' + cdsServices[k].length; }).join(', '));
      cb();
    }).catch(function(e) { console.error('[CDS] Discovery failed:', e); cb(); });
  }

  // ===== Fire Hook =====
  function fireHook(hookType, extraContext) {
    var services = cdsServices[hookType] || [];
    if (!services.length) return;
    services.forEach(function(svc) {
      var body = {
        hookInstance: crypto.randomUUID(),
        hook: hookType,
        fhirServer: serverUrl,
        fhirAuthorization: { access_token: smartToken || accessToken, token_type: 'Bearer', expires_in: 3600, scope: 'system/*.cruds', subject: CFG.CLIENT_ID },
        context: Object.assign({ userId: 'Practitioner/' + (sessionStorage.getItem('uname') || CFG.DEFAULT_PROVIDER), patientId: currentPatientId || launchPatientId }, extraContext || {}),
        extension: { 'digicare-run': runId }
      };
      var url = CFG.CDS_BASE + '/cds-hooks/' + CFG.CDS_PROXY + '/cds-services/' + svc.id;
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': smartToken ? 'Bearer ' + smartToken : '' }, body: JSON.stringify(body) })
        .then(function(r) { if (r.ok) return r.json(); throw new Error(r.status); })
        .then(function(data) {
          (data.cards || []).forEach(function(card) { renderCard(card, svc.id); });
        })
        .catch(function(e) { console.warn('[CDS] ' + svc.id + ' error:', e.message); });
    });
  }

  // ===== Card Renderer =====
  function renderCard(card, serviceId) {
    var uid = card.uuid || Math.random().toString(36).substr(2, 8);
    if (renderedCards[uid]) return;
    renderedCards[uid] = true;
    cardQueue.push({card: card, serviceId: serviceId, uid: uid});
    if (!cardQueueTimer) processCardQueue();
  }

  function processCardQueue() {
    if (!cardQueue.length) { cardQueueTimer = null; return; }
    var item = cardQueue.shift();
    renderCardNow(item.card, item.serviceId, item.uid);
    cardQueueTimer = setTimeout(processCardQueue, 2500);
  }


  // ===== Card i18n =====
  var CARD_I18N = {
    // Source labels
    'DigiCare CDS': 'DigiCare 臨床決策',
    'DigiCare AI': 'DigiCare AI',
    'AI 摘要': 'AI 摘要',
    'AI 影像分析': 'AI 影像分析',
    '即時通知': '即時通知',
    '藥物安全': '藥物安全',
    '藥品建議': '藥品建議',
    '檢驗建議': '檢驗建議',
    '劑量顧問': '劑量顧問',
    '健保審查': '健保審查',
    '重複檢核': '重複檢核',
    '門診流程': '門診流程',
    '系統公告': '系統公告',
    '看診評估': '看診評估',
    '檢驗通知': '檢驗通知',
    '照護計畫': '照護計畫',
  };

  var CARD_TEXT_REPLACE = [
    [/[a-f0-9-]{6,}\s*號病患/gi, '這位病患'],
    [/Dr\.\s*[a-f0-9-]{6,}/gi, sessionStorage.getItem('uname') ? 'Dr. ' + sessionStorage.getItem('uname') : '醫師'],
    [/\d{5,}\s*號病患/g, '這位病患'],
    [/病房護理師回報/g, '護理站回報'],
    [/Patient ([a-z0-9-]{8})/gi, '這位患者'],
    [/Patient\/([a-z0-9-]+)/gi, '這位患者'],
    [/\bBI-RADS\s*4B\b/g, '中高度懷疑'],
    [/\bBI-RADS\s*\d\b/g, '風險分級'],
    [/\beGFR\s*\d+\s*mL\/min/g, '腎功能指數偏低'],
    [/\beGFR/g, '腎功能指數'],
    [/\bGOT\/GPT/g, '肝指數'],
    [/\bHbA1c/g, '血糖'],
    [/Systolic BP\s*=\s*(\d+)\s*mmHg[^.]*\./g, '血壓收縮壓 $1，偏高。'],
    [/\bmmHg/g, ''],
    [/\bReview antihypertensive\.?/gi, '建議調整降壓藥'],
    [/\bAdjust glycemic control\.?/gi, '建議調整血糖控制方案'],
    [/\bImmediate intervention needed\.?/gi, '需要立即處置'],
    [/\babove target/gi, '超過標準'],
    [/\bLab values normal/gi, '檢驗數值正常'],
    [/\bNo .* records?\b\.?/gi, '無相關紀錄'],
    [/\bConsider ordering labs\.?/gi, '建議安排檢查'],
    [/elevated\s*\(>\d+\)/gi, '偏高'],
    [/\bCRITICAL:\s*/gi, '嚴重：'],
    [/\bWARNING:\s*/gi, '警告：'],
    [/\bALLERGY ALERT:\s*/gi, '過敏警告：'],
    [/\bWarfarin/g, '華法林'],
    [/\bAspirin/g, '阿斯匹靈'],
    [/\bMetformin/g, '二甲雙胍'],
    [/\bIbuprofen/g, '布洛芬'],
    [/\bAmoxicillin/g, '安摩西林'],
    [/\bPenicillin/g, '盘尼西林'],
    [/\bbleeding risk/gi, '出血風險'],
    [/\bpolypharmacy/gi, '多重用藥'],
    [/\bactive medication/gi, '用藥'],
    [/\binteraction/gi, '交互作用'],
    [/\bdetected/gi, '偵測到'],
    [/\bcombination/gi, '併用'],
    [/\bNo contraindications found/gi, '未發現禁忌證'],
    [/\bProceed with order/gi, '可以繼續處理'],
    [/\bVerify drug safety/gi, '請確認用藥安全'],
    [/\bknown allergies/gi, '藥物過敏紀錄'],
    [/\ballergy/gi, '過敏'],
    [/\bdosage/gi, '劑量'],
    [/\belderly patient/gi, '高齡患者'],
    [/\brenal impairment/gi, '腎功能不佳'],
    [/\bAdjust .* accordingly/gi, '請適當調整'],
  ];

  function translateCard(card) {
    var c = JSON.parse(JSON.stringify(card));
    if (c.source && c.source.label) {
      c.source.label = CARD_I18N[c.source.label] || c.source.label;
    }
    if (c.summary) c.summary = applyTextReplace(c.summary);
    if (c.detail) c.detail = applyTextReplace(c.detail);
    return c;
  }

  function resolvePatientName(pid) {
    if (!pid) return '';
    var p = allPatients.find(function(x) { return x.id === pid; });
    return p ? getPatientName(p) : '';
  }

  function applyTextReplace(text) {
    // Replace patient IDs with names from loaded patient list
    allPatients.forEach(function(p) {
      var name = getPatientName(p);
      var idShort = p.id.substring(0, 8);
      text = text.split(p.id).join(name);
      text = text.split(idShort).join(name);
    });
    CARD_TEXT_REPLACE.forEach(function(pair) {
      text = text.replace(pair[0], pair[1]);
    });
    return text;
  }

  function renderCardNow(origCard, serviceId, uid) {
    var card = translateCard(origCard);

    var ind = card.indicator || 'info';
    var cls = ind === 'critical' ? 'crit' : ind === 'warning' ? 'warn' : '';

    var el = document.createElement('div');
    el.className = 'cds-card ' + cls;
    el.dataset.serviceId = serviceId;
    el.dataset.cardUuid = uid;

    var hasDetail = !!card.detail;
    var srcLabel = (card.source && card.source.label) || 'CDS';
    var expandHint = hasDetail ? '<span class="card-expand-hint">[展開]</span>' : '';
    var timerHtml = ind === 'critical' ? '<span class="card-timer" data-seconds="30">0:30</span>' : '';
    var html = '<div class="card-source"><span>' + esc(srcLabel) + '</span>' + expandHint + timerHtml + '</div>';
    html += '<div class="card-summary">' + esc(card.summary || '') + '</div>';

    if (card.detail) {
      var detail = esc(card.detail).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
      html += '<div class="card-detail">' + detail + '</div>';
    }

    // Links
    if (card.links && card.links.length) {
      html += '<div class="card-actions">';
      card.links.forEach(function(lnk) {
        if (lnk.type === 'absolute' && lnk.url) {
          html += '<button class="link-btn" onclick="window.open(\'' + esc(lnk.url) + '\',\'_blank\')">' + esc(lnk.label || 'Open') + '</button>';
        }
      });
      html += '</div>';
    }

    // Suggestions + override
    if (card.suggestions && card.suggestions.length) {
      var atMostOne = card.selectionBehavior === 'at-most-one';
      html += '<div class="card-actions" data-atmostone="' + atMostOne + '">';
      card.suggestions.forEach(function(sug) {
        html += '<button class="sug-btn" data-sug-label="' + esc(sug.label) + '" onclick="window._acceptSug(this)">' + esc(sug.label) + '</button>';
      });
      html += '<button class="skip-btn" onclick="window._skipCard(this)">Skip</button>';
      html += '</div>';
      if (card.overrideReasons && card.overrideReasons.length) {
        html += '<select class="override-select" hidden>';
        html += '<option value="">Select reason...</option>';
        card.overrideReasons.forEach(function(r) {
          html += '<option value="' + esc(r.code) + '">' + esc(r.display) + '</option>';
        });
        html += '</select>';
      }
    }

    el.innerHTML = html;
    el.addEventListener('click', function(e) {
      if (e.target.closest('.sug-btn,.skip-btn,.link-btn,.override-select,.draft-remove')) return;
      this.classList.toggle('expanded');
      var hint = this.querySelector('.card-expand-hint');
      if (hint) hint.textContent = this.classList.contains('expanded') ? '[收合]' : '[展開]';
    });

    // Auto-dismiss info cards after 30s
    if (ind === 'info') {
      setTimeout(function() {
        el.classList.add('dismissing');
        setTimeout(function() {
          el.dataset.dismissed = 'true';
          el.hidden = (currentFilter !== 'dismissed' && currentFilter !== 'all');
          el.classList.remove('dismissing');
          el.style.opacity = '1';
          dismissedCards.push(uid);
          updateCardCount();
        }, 1000);
      }, 30000);
    }
    updateCardCount();

    var feed = document.getElementById('chatFeed');
    feed.insertBefore(el, feed.firstChild);

    // Danmaku
    if (true) {
      spawnDanmaku(card.summary || '', ind);
    }

    // Critical timer
    if (ind === 'critical') {
      startCardTimer(el);
    }
  }

  // ===== Suggestions =====
  window._acceptSug = function(btn) {
    var cardEl = btn.closest('.cds-card');
    var serviceId = cardEl.dataset.serviceId;
    var cardUuid = cardEl.dataset.cardUuid;
    var label = btn.dataset.sugLabel;
    var actionsDiv = btn.parentElement;
    var atMostOne = actionsDiv.dataset.atmostone === 'true';

    if (atMostOne) {
      actionsDiv.querySelectorAll('.sug-btn').forEach(function(b) { b.disabled = true; });
    }
    btn.disabled = true;
    btn.style.opacity = '1';
    btn.style.background = 'var(--accent-ok)';
    actionsDiv.querySelector('.skip-btn').hidden = true;

    var statusEl = document.createElement('div');
    statusEl.className = 'card-accepted';
    statusEl.textContent = '已接受：' + label;
    cardEl.appendChild(statusEl);

    applySuggestion(label);
    sendFeedback(serviceId, cardUuid, 'accepted', label, null);
  };

  window._skipCard = function(btn) {
    var cardEl = btn.closest('.cds-card');
    var serviceId = cardEl.dataset.serviceId;
    var cardUuid = cardEl.dataset.cardUuid;
    var selectEl = cardEl.querySelector('.override-select');

    if (selectEl) {
      selectEl.hidden = false;
      selectEl.onchange = function() {
        if (!this.value) return;
        var reason = { code: this.value, display: this.options[this.selectedIndex].text };
        cardEl.querySelector('.card-actions').hidden = true;
        selectEl.hidden = true;
        var statusEl = document.createElement('div');
        statusEl.className = 'card-skipped';
        statusEl.textContent = '已略過：' + reason.display;
        cardEl.appendChild(statusEl);
        sendFeedback(serviceId, cardUuid, 'overridden', null, reason);
      };
    } else {
      btn.parentElement.hidden = true;
      var statusEl = document.createElement('div');
      statusEl.className = 'card-skipped';
      statusEl.textContent = '已略過';
      cardEl.appendChild(statusEl);
      sendFeedback(serviceId, cardUuid, 'overridden', null, null);
    }
  };

  function applySuggestion(label) {
    var l = label.toLowerCase();
    if (l.indexOf('改用') >= 0) {
      var alt = label.replace(/^.*改用\s*/, '');
      if (drafts.length) drafts.pop();
      addDraft('med', alt.toLowerCase().replace(/\s/g, '-'), alt);
    } else if (l.indexOf('檢驗') >= 0 || l.indexOf('lab') >= 0) {
      addDraft('lab', 'lab-ordered', 'Baseline Lab Panel');
    }
    renderDrafts();
  }

  function sendFeedback(serviceId, cardUuid, outcome, acceptedLabel, overrideReason) {
    var fb = { card: cardUuid, outcome: outcome };
    if (acceptedLabel) fb.acceptedSuggestions = [{ id: acceptedLabel }];
    if (overrideReason) fb.overrideReason = overrideReason;
    var body = { feedback: [fb], extension: { 'digicare-run': runId } };
    var url = CFG.CDS_BASE + '/cds-hooks/' + CFG.CDS_PROXY + '/cds-services/' + serviceId + '/feedback';
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': smartToken ? 'Bearer ' + smartToken : '' }, body: JSON.stringify(body) })
      .then(function(r) { return r.json(); })
      .then(function(d) { console.log('[Feedback]', d); })
      .catch(function(e) { console.warn('[Feedback error]', e); });
  }

  // ===== Card Timer =====
  function startCardTimer(el) {
    var timerEl = el.querySelector('.card-timer');
    if (!timerEl) return;
    var seconds = 30;
    var iv = setInterval(function() {
      seconds--;
      if (seconds <= 0) { clearInterval(iv); timerEl.textContent = '已過期'; el.style.opacity = '.5'; return; }
      timerEl.textContent = '0:' + (seconds < 10 ? '0' : '') + seconds;
    }, 1000);
  }

  // ===== Danmaku =====
  var DANMAKU_LANES = 6;
  var danmakuLaneTime = [0,0,0,0,0,0];
  function spawnDanmaku(text, level) {
    if (!dmSettings.enabled) return;
    var now = Date.now();
    var bestLane = 0;
    var bestGap = 0;
    for (var li = 0; li < DANMAKU_LANES; li++) {
      var gap = now - danmakuLaneTime[li];
      if (gap > bestGap) { bestGap = gap; bestLane = li; }
    }
    danmakuLaneTime[bestLane] = now;
    var lane = bestLane;
    var layer = document.getElementById('danmakuLayer');
    var el = document.createElement('span');
    var cls = level === 'critical' ? 'crit' : level === 'warning' ? 'warn' : 'info';
    el.className = 'danmaku-text ' + cls;
    el.textContent = text;
    el.style.top = (8 + lane * 14) + '%';
    var baseSpeed = dmSettings.speed;
    var dur = level === 'critical' ? baseSpeed * 1.3 : level === 'warning' ? baseSpeed * 1.1 : baseSpeed;
    el.style.animationDuration = dur + 's';
    el.style.fontSize = (dmSettings.size / 100) + 'em';
    el.style.opacity = dmSettings.opacity / 100;
    layer.appendChild(el);
    el.addEventListener('animationend', function() { el.remove(); });
  }

  // ===== Drafts =====
  function addDraft(kind, key, text) {
    draftCounter++;
    drafts.push({ id: 'draft-' + key + '-' + draftCounter, kind: kind, key: key, text: text });
    renderDrafts();
  }

  function removeDraft(id) {
    drafts = drafts.filter(function(d) { return d.id !== id; });
    renderDrafts();
  }

  function renderDrafts() {
    var panel = document.getElementById('draftPanel');
    var list = document.getElementById('draftList');
    if (!drafts.length) { panel.hidden = true; return; }
    panel.hidden = false;
    list.innerHTML = drafts.map(function(d) {
      return '<div class="draft-item"><span class="draft-kind ' + d.kind + '">' + d.kind.toUpperCase() + '</span>'
        + '<span class="draft-text">' + esc(d.text) + '</span>'
        + '<button class="draft-remove" onclick="window._removeDraft(\'' + d.id + '\')">&times;</button></div>';
    }).join('');
  }
  window._removeDraft = function(id) { removeDraft(id); };

  function buildDraftOrdersBundle() {
    return {
      resourceType: 'Bundle', type: 'collection',
      entry: drafts.map(function(d) {
        return {
          resource: {
            resourceType: d.kind === 'med' ? 'MedicationRequest' : 'ServiceRequest',
            id: d.id, status: 'draft', intent: 'order',
            medicationCodeableConcept: d.kind === 'med' ? { text: d.text } : undefined,
            code: d.kind === 'lab' ? { text: d.text } : undefined,
            subject: { reference: 'Patient/' + currentPatientId }
          }
        };
      })
    };
  }

  // ===== Action Bar =====
  function buildMenus() {
    var drugMenu = document.getElementById('drugMenu');
    var labMenu = document.getElementById('labMenu');
    CFG.DRUGS.forEach(function(d) {
      var btn = document.createElement('button');
      btn.textContent = d.text;
      btn.onclick = function() { orderDrug(d.key, d.text); };
      drugMenu.appendChild(btn);
    });
    CFG.LABS.forEach(function(l) {
      var btn = document.createElement('button');
      btn.textContent = l.text;
      btn.onclick = function() { orderLab(l.key, l.text); };
      labMenu.appendChild(btn);
    });
  }

  window.startVisit = function() {
    visitOpen = true;
    fireHook('encounter-start', { patientId: currentPatientId });
    startTick();
  };

  function orderDrug(key, text) {
    addDraft('med', key, text);
    fireHook('order-select', {
      patientId: currentPatientId,
      selections: ['MedicationRequest/draft-' + key + '-' + draftCounter],
      draftOrders: buildDraftOrdersBundle()
    });
  }

  function orderLab(key, text) {
    addDraft('lab', key, text);
    fireHook('order-select', {
      patientId: currentPatientId,
      selections: ['ServiceRequest/draft-' + key + '-' + draftCounter],
      draftOrders: buildDraftOrdersBundle()
    });
  }

  window.signOrder = function() {
    fireHook('order-sign', {
      patientId: currentPatientId,
      draftOrders: buildDraftOrdersBundle()
    });
  };

  window.endVisit = function() {
    fireHook('encounter-discharge', { patientId: currentPatientId });
    visitOpen = false;
    stopTick();
    setTimeout(function() { drafts = []; renderDrafts(); }, 2000);
  };

  // ===== Tick =====
  function startTick() {
    stopTick();
    function tick() {
      if (!visitOpen || !currentPatientId) return;
      fireHook('encounter-tick', { patientId: currentPatientId });
      var delay = CFG.TICK_MIN + Math.random() * (CFG.TICK_MAX - CFG.TICK_MIN);
      tickTimer = setTimeout(tick, delay);
    }
    var delay = CFG.TICK_MIN + Math.random() * (CFG.TICK_MAX - CFG.TICK_MIN);
    tickTimer = setTimeout(tick, delay);
  }

  function stopTick() {
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  }

  // ===== Patient List =====
  function loadPatients() {
    fhirGet('/Patient?_count=50').then(function(bundle) {
      allPatients = (bundle.entry || []).map(function(e) { return e.resource; });
      renderPatientList();
    }).catch(function(e) {
      document.getElementById('patientList').innerHTML = '<div class="loading-center"><p style="color:var(--accent-crit)">' + e.message + '</p></div>';
    });
  }

  function renderPatientList() {
    var container = document.getElementById('patientList');
    if (!allPatients.length) { container.innerHTML = '<div class="loading-center"><p>No patients</p></div>'; return; }
    container.innerHTML = allPatients.map(function(p) {
      var name = getPatientName(p);
      var isActive = p.id === launchPatientId;
      return '<div class="patient-item' + (isActive ? ' active' : '') + '" data-id="' + p.id + '" onclick="window._selectPatient(\'' + p.id + '\')">'
        + '<img src="https://api.dicebear.com/9.x/avataaars/svg?seed=' + encodeURIComponent(p.id) + '&backgroundType=gradientLinear&backgroundColor=b6e3f4,c0aede,d1d4f9" alt="">'
        + '<div class="patient-info"><div class="patient-name">' + esc(name) + '</div><div class="patient-id">' + esc(p.id) + '</div></div></div>';
    }).join('');
    if (launchPatientId) {
      var target = allPatients.find(function(p) { return p.id === launchPatientId; });
      if (target) selectPatient(target);
    }
  }

  window._selectPatient = function(pid) {
    document.querySelectorAll('.patient-item').forEach(function(el) { el.classList.toggle('active', el.dataset.id === pid); });
    var p = allPatients.find(function(x) { return x.id === pid; });
    if (p) selectPatient(p);
  };

  function selectPatient(patient) {
    currentPatientId = patient.id;
    loadPatientDetail(patient);
    fireHook('patient-view', { patientId: patient.id });
  }

  // ===== Patient Detail =====
  function loadPatientDetail(patient) {
    var center = document.getElementById('centerContent');
    var name = getPatientName(patient);
    var avatarUrl = 'https://api.dicebear.com/9.x/avataaars/svg?seed=' + encodeURIComponent(patient.id) + '&backgroundType=gradientLinear&backgroundColor=b6e3f4,c0aede,d1d4f9';

    var html = '<div class="detail-card">'
      + '<div class="patient-summary">'
      + '<div class="avatar-side"><img src="' + avatarUrl + '" alt=""></div>'
      + '<div class="info-side">'
      + '<div class="name">' + esc(name) + '</div>'
      + '<div class="meta">ID: ' + esc(patient.id) + '</div>'
      + '<div class="info-grid">'
      + infoBox('出生日期', formatDate(patient.birthDate))
      + infoBox('年齡', calcAge(patient.birthDate))
      + infoBox('性別', patient.gender || 'N/A')
      + infoBox('聯絡電話', getPhone(patient))
      + '</div></div></div></div>';

    html += '<div class="detail-card">'
      + '<div class="tabs">'
      + '<button class="tab-btn active" data-tab="tab-med">用藥紀錄</button>'
      + '<button class="tab-btn" data-tab="tab-cond">診斷紀錄</button>'
      + '<button class="tab-btn" data-tab="tab-obs">檢驗數據</button>'
      + '<button class="tab-btn" data-tab="tab-raw">原始資料</button>'
      + '</div>'
      + '<div id="tab-med" class="tab-pane active"><div class="loading-center"><div class="spinner"></div></div></div>'
      + '<div id="tab-cond" class="tab-pane"><div class="loading-center"><div class="spinner"></div></div></div>'
      + '<div id="tab-obs" class="tab-pane"><div class="loading-center"><div class="spinner"></div></div></div>'
      + '<div id="tab-raw" class="tab-pane"><div class="raw-json">' + esc(JSON.stringify(patient, null, 2)) + '</div></div>'
      + '</div>';
    center.innerHTML = html;
    bindTabs();

    fhirGet('/MedicationRequest?patient=' + patient.id).then(function(d) {
      renderResList('tab-med', d.entry, medName, medDetail);
    }).catch(function(e) { document.getElementById('tab-med').innerHTML = errBox(e); });
    fhirGet('/Condition?patient=' + patient.id).then(function(d) {
      renderResList('tab-cond', d.entry, condName, condDetail);
    }).catch(function(e) { document.getElementById('tab-cond').innerHTML = errBox(e); });
    fhirGet('/Observation?patient=' + patient.id + '&_count=30').then(function(d) {
      renderResList('tab-obs', d.entry, obsName, obsDetail);
    }).catch(function(e) { document.getElementById('tab-obs').innerHTML = errBox(e); });
  }

  // ===== Doctor Card =====
  function renderDoctorCard() {
    var name = sessionStorage.getItem('uname') || 'Clinician';
    var avatarUrl = 'https://api.dicebear.com/9.x/notionists/svg?seed=' + encodeURIComponent(name) + '&backgroundColor=e8eef5';
    var el = document.getElementById('doctorCard');
    if (!el) return;
    var titles = ['主治醫師','主任醫師','住院醫師','專科護理師','資深主治醫師'];
    var depts = ['一般內科','心臟內科','胸腔外科','神經內科','急診醫學科','家庭醫學科','小兒科','骨科'];
    var h = 0; for (var ci = 0; ci < name.length; ci++) h = ((h << 5) - h) + name.charCodeAt(ci); h = Math.abs(h);
    var title = titles[h % titles.length];
    var dept = depts[(h >>> 4) % depts.length];
    el.innerHTML = '<img src="' + avatarUrl + '" alt="">'
      + '<div class="doctor-info"><div class="doctor-name">' + esc(name) + '</div>'
      + '<div class="doctor-role">' + esc(title) + ' · ' + esc(dept) + '</div>'
      + '<div class="doctor-status"><span class="dot"></span> 線上</div></div>';
  }

  // ===== Tabs =====
  function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-pane').forEach(function(p) { p.classList.remove('active'); });
        this.classList.add('active');
        document.getElementById(this.dataset.tab).classList.add('active');
      });
    });
  }

  function renderResList(containerId, entries, nameFn, detailFn) {
    var el = document.getElementById(containerId);
    if (!entries || !entries.length) { el.innerHTML = '<div class="no-data">No records</div>'; return; }
    el.innerHTML = '<ul class="res-list">' + entries.map(function(e) {
      return '<li class="res-item"><div class="res-name">' + esc(nameFn(e.resource)) + '</div><div class="res-detail">' + esc(detailFn(e.resource)) + '</div></li>';
    }).join('') + '</ul>';
  }

  // ===== Resource Extractors =====
  function medName(r) {
    if (r.medicationCodeableConcept) return r.medicationCodeableConcept.text || (r.medicationCodeableConcept.coding && r.medicationCodeableConcept.coding[0] && r.medicationCodeableConcept.coding[0].display) || '未知';
    return (r.medicationReference && r.medicationReference.display) || '未知';
  }
  function medDetail(r) { return '狀態：' + (r.status || 'N/A') + ' | ' + formatDate(r.authoredOn); }
  function condName(r) { return (r.code && (r.code.text || (r.code.coding && r.code.coding[0] && r.code.coding[0].display))) || '未知'; }
  function condDetail(r) {
    var s = r.clinicalStatus && r.clinicalStatus.coding && r.clinicalStatus.coding[0] ? r.clinicalStatus.coding[0].code : 'N/A';
    return '狀態：' + s + ' | 發病：' + formatDate(r.onsetDateTime);
  }
  function obsName(r) { return (r.code && (r.code.text || (r.code.coding && r.code.coding[0] && r.code.coding[0].display))) || '未知'; }
  function obsDetail(r) {
    var v = 'N/A';
    if (r.valueQuantity) v = r.valueQuantity.value + ' ' + (r.valueQuantity.unit || '');
    else if (r.valueString) v = r.valueString;
    return '數值：' + v + ' | ' + formatDate(r.effectiveDateTime);
  }

  // ===== FHIR =====
  function fhirGet(path) {
    return fetch(serverUrl + path, { headers: { 'Authorization': 'Bearer ' + accessToken } })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  // ===== Utility =====
  function getPatientName(p) {
    if (!p.name || !p.name.length) return '未知';
    var n = p.name[0]; if (n.text) return n.text;
    var parts = []; if (n.family) parts.push(n.family); if (n.given) parts = parts.concat(n.given);
    return parts.join(' ') || '未知';
  }
  function formatDate(d) { if (!d) return 'N/A'; try { return new Date(d).toLocaleDateString('zh-TW'); } catch(e) { return d; } }
  function calcAge(b) { if (!b) return 'N/A'; return (new Date().getFullYear() - new Date(b).getFullYear()) + ' 歲'; }
  function getPhone(p) { if (!p.telecom) return 'N/A'; var ph = p.telecom.find(function(t) { return t.system === 'phone'; }); return ph ? ph.value : 'N/A'; }
  function infoBox(label, value) { return '<div class="info-box"><div class="label">' + label + '</div><div class="value">' + esc(value) + '</div></div>'; }
  function errBox(e) { return '<div style="color:var(--accent-crit);padding:.75rem;font-size:.85rem;">' + esc(e.message) + '</div>'; }
  function esc(s) { if (!s) return ''; var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

  // ===== Card Filter =====
  window._filterCards = function(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('.card-filter button').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelectorAll('.cds-card').forEach(function(el) {
      var ind = el.classList.contains('crit') ? 'critical' : el.classList.contains('warn') ? 'warning' : 'info';
      var isDismissed = el.dataset.dismissed === 'true';
      if (filter === 'all') { el.hidden = isDismissed; }
      else if (filter === 'dismissed') { el.hidden = !isDismissed; }
      else { el.hidden = (ind !== filter) || isDismissed; }
    });
  };

  window._clearCards = function() {
    document.querySelectorAll('.cds-card').forEach(function(el) {
      el.dataset.dismissed = 'true';
      el.hidden = (currentFilter !== 'dismissed');
    });
    updateCardCount();
  };

  function updateCardCount() {
    var count = document.querySelectorAll('.cds-card:not([hidden])').length;
    var el = document.getElementById('cardCount');
    if (el) el.textContent = count + ' 張';
  }

  // ===== Danmaku Controls =====
  window._dmCtrl = function(key, val) {
    if (key === 'size') dmSettings.size = parseInt(val);
    else if (key === 'speed') dmSettings.speed = parseInt(val);
    else if (key === 'opacity') dmSettings.opacity = parseInt(val);
    if (key === 'size' || key === 'speed' || key === 'opacity') {
      document.querySelectorAll('.danmaku-text').forEach(function(el) {
        if (key === 'size') el.style.fontSize = (dmSettings.size / 100) + 'em';
        if (key === 'opacity') el.style.opacity = dmSettings.opacity / 100;
        if (key === 'speed') el.style.animationDuration = dmSettings.speed + 's';
      });
    }
    else if (key === 'toggle') {
      dmSettings.enabled = !dmSettings.enabled;
      var btn = document.getElementById('dmToggle');
      btn.textContent = dmSettings.enabled ? '\u95dc\u9589\u5f48\u5e55' : '\u958b\u555f\u5f48\u5e55';
      btn.classList.toggle('active', !dmSettings.enabled);
      if (!dmSettings.enabled) {
        document.querySelectorAll('.danmaku-text').forEach(function(el) { el.remove(); });
        danmakuCount = 0;
      }
    }
  };

  // ===== Logout =====
  window.doLogout = function() { sessionStorage.clear(); location.href = 'index.html'; };
})();
