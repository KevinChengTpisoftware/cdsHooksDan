(function() {
  'use strict';

  var serverUrl = '';
  var accessToken = '';
  var launchPatientId = '';
  var allPatients = [];

  // ===== Init =====
  window.onload = function() {
    var ps = new URLSearchParams(location.search);
    var isCallback = sessionStorage.getItem('ehr_launched') || ps.has('code') || ps.has('state');

    if (!isCallback) {
      location.href = 'index.html';
      return;
    }

    sessionStorage.removeItem('ehr_launched');
    extractIdentity();
    acquireToken();
  };

  // ===== Identity from SMART id_token =====
  function extractIdentity() {
    try {
      FHIR.oauth2.ready().then(function(cl) {
        serverUrl = cl.state.serverUrl || '';
        if (cl.patient && cl.patient.id) {
          launchPatientId = cl.patient.id;
          sessionStorage.setItem('launchPid', launchPatientId);
        }
        var tr = cl.state.tokenResponse || {};
        var idt = tr.id_token;
        if (idt) {
          var u = decodeJwt(idt);
          var name = u.name || u.preferred_username || u.sub || '';
          showUser(name, u.email || '');
        }
      }).catch(function() {});
    } catch(e) {}
  }

  function decodeJwt(token) {
    var b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function showUser(name, email) {
    sessionStorage.setItem('uemail', email);
    sessionStorage.setItem('uname', name);
    document.getElementById('userArea').hidden = true;
    renderDoctorCard();
  }

  // ===== Token (client_credentials) =====
  function acquireToken() {
    var cid = sessionStorage.getItem('cfgC') || CFG.CLIENT_ID;
    var secret = CFG.CLIENT_SECRET;
    var basicAuth = btoa(cid + ':' + btoa(secret));

    fetch(CFG.BASE + '/dgrv4/ssotoken/smart/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + basicAuth
      },
      body: 'grant_type=client_credentials'
    })
    .then(function(r) { return r.json(); })
    .then(function(tok) {
      if (!tok.access_token) throw new Error('No token: ' + JSON.stringify(tok));
      accessToken = tok.access_token;
      resolveServerUrl();
      renderDoctorCard();
      loadPatients();
    })
    .catch(function(e) {
      document.getElementById('patientList').innerHTML =
        '<div class="loading-center"><p style="color:var(--accent-crit)">Token error: ' + e.message + '</p></div>';
    });
  }

  function resolveServerUrl() {
    if (!serverUrl) {
      serverUrl = CFG.BASE + '/smart-on-fhir/digiCare/fhir';
    }
    if (!launchPatientId) {
      launchPatientId = sessionStorage.getItem('launchPid') ||
                        sessionStorage.getItem('cfgP') ||
                        CFG.DEFAULT_PATIENT;
    }
  }

  // ===== Patient list =====
  function loadPatients() {
    fhirGet('/Patient?_count=50')
    .then(function(bundle) {
      allPatients = (bundle.entry || []).map(function(e) { return e.resource; });
      renderPatientList();
    })
    .catch(function(e) {
      document.getElementById('patientList').innerHTML =
        '<div class="loading-center"><p style="color:var(--accent-crit)">' + e.message + '</p></div>';
    });
  }

  function renderPatientList() {
    var container = document.getElementById('patientList');
    if (!allPatients.length) {
      container.innerHTML = '<div class="loading-center"><p>No patients found</p></div>';
      return;
    }
    var html = '';
    allPatients.forEach(function(p) {
      var name = getPatientName(p);
      var isActive = p.id === launchPatientId;
      html += '<div class="patient-item' + (isActive ? ' active' : '') + '" data-id="' + p.id + '" onclick="window._selectPatient(\'' + p.id + '\')">'
        + '<img src="https://api.dicebear.com/9.x/avataaars/svg?seed=' + encodeURIComponent(p.id) + '&backgroundType=gradientLinear&backgroundColor=b6e3f4,c0aede,d1d4f9" alt="">'
        + '<div class="patient-info">'
        + '<div class="patient-name">' + escHtml(name) + '</div>'
        + '<div class="patient-id">' + escHtml(p.id) + '</div>'
        + '</div></div>';
    });
    container.innerHTML = html;
    if (launchPatientId) {
      var target = allPatients.find(function(p) { return p.id === launchPatientId; });
      if (target) loadPatientDetail(target);
    }
  }

  window._selectPatient = function(pid) {
    document.querySelectorAll('.patient-item').forEach(function(el) {
      el.classList.toggle('active', el.dataset.id === pid);
    });
    var p = allPatients.find(function(x) { return x.id === pid; });
    if (p) loadPatientDetail(p);
  };

  // ===== Patient detail =====
  function loadPatientDetail(patient) {
    var center = document.getElementById('centerPanel');
    var name = getPatientName(patient);
    var avatarUrl = 'https://api.dicebear.com/9.x/avataaars/svg?seed=' + encodeURIComponent(patient.id) + '&backgroundType=gradientLinear&backgroundColor=b6e3f4,c0aede,d1d4f9';

    var html = '<div class="detail-card">'
      + '<div class="patient-summary">'
      + '<div class="avatar-side"><img src="' + avatarUrl + '" alt=""></div>'
      + '<div class="info-side">'
      + '<div class="name">' + escHtml(name) + '</div>'
      + '<div class="meta">ID: ' + escHtml(patient.id) + '</div>'
      + '<div class="info-grid">'
      + infoBox('Birthday', formatDate(patient.birthDate))
      + infoBox('Age', calcAge(patient.birthDate))
      + infoBox('Gender', patient.gender || 'N/A')
      + infoBox('Phone', getPhone(patient))
      + '</div></div></div></div>';

    html += '<div class="detail-card">'
      + '<div class="tabs">'
      + '<button class="tab-btn active" data-tab="tab-med">Medications</button>'
      + '<button class="tab-btn" data-tab="tab-cond">Conditions</button>'
      + '<button class="tab-btn" data-tab="tab-obs">Observations</button>'
      + '<button class="tab-btn" data-tab="tab-raw">Raw JSON</button>'
      + '</div>'
      + '<div id="tab-med" class="tab-pane active"><div class="loading-center"><div class="spinner"></div></div></div>'
      + '<div id="tab-cond" class="tab-pane"><div class="loading-center"><div class="spinner"></div></div></div>'
      + '<div id="tab-obs" class="tab-pane"><div class="loading-center"><div class="spinner"></div></div></div>'
      + '<div id="tab-raw" class="tab-pane"><div class="raw-json">' + escHtml(JSON.stringify(patient, null, 2)) + '</div></div>'
      + '</div>';

    center.innerHTML = html;
    bindTabs();

    fhirGet('/MedicationRequest?patient=' + patient.id).then(function(d) {
      renderResourceList('tab-med', d.entry, medName, medDetail);
    }).catch(function(e) { document.getElementById('tab-med').innerHTML = errBox(e); });

    fhirGet('/Condition?patient=' + patient.id).then(function(d) {
      renderResourceList('tab-cond', d.entry, condName, condDetail);
    }).catch(function(e) { document.getElementById('tab-cond').innerHTML = errBox(e); });

    fhirGet('/Observation?patient=' + patient.id + '&_count=30').then(function(d) {
      renderResourceList('tab-obs', d.entry, obsName, obsDetail);
    }).catch(function(e) { document.getElementById('tab-obs').innerHTML = errBox(e); });
  }

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

  function renderResourceList(containerId, entries, nameFn, detailFn) {
    var el = document.getElementById(containerId);
    if (!entries || !entries.length) {
      el.innerHTML = '<div class="no-data">No records</div>';
      return;
    }
    var html = '<ul class="res-list">';
    entries.forEach(function(e) {
      html += '<li class="res-item"><div class="res-name">' + escHtml(nameFn(e.resource))
        + '</div><div class="res-detail">' + escHtml(detailFn(e.resource)) + '</div></li>';
    });
    el.innerHTML = html + '</ul>';
  }

  // ===== Resource name/detail extractors =====
  function medName(r) {
    if (r.medicationCodeableConcept) {
      return r.medicationCodeableConcept.text
        || (r.medicationCodeableConcept.coding && r.medicationCodeableConcept.coding[0] && r.medicationCodeableConcept.coding[0].display)
        || 'Unknown';
    }
    return (r.medicationReference && r.medicationReference.display) || 'Unknown';
  }
  function medDetail(r) { return 'Status: ' + (r.status || 'N/A') + ' | ' + formatDate(r.authoredOn); }

  function condName(r) {
    return (r.code && (r.code.text || (r.code.coding && r.code.coding[0] && r.code.coding[0].display))) || 'Unknown';
  }
  function condDetail(r) {
    var s = r.clinicalStatus && r.clinicalStatus.coding && r.clinicalStatus.coding[0]
      ? r.clinicalStatus.coding[0].code : 'N/A';
    return 'Status: ' + s + ' | Onset: ' + formatDate(r.onsetDateTime);
  }

  function obsName(r) {
    return (r.code && (r.code.text || (r.code.coding && r.code.coding[0] && r.code.coding[0].display))) || 'Unknown';
  }
  function obsDetail(r) {
    var v = 'N/A';
    if (r.valueQuantity) v = r.valueQuantity.value + ' ' + (r.valueQuantity.unit || '');
    else if (r.valueString) v = r.valueString;
    return 'Value: ' + v + ' | ' + formatDate(r.effectiveDateTime);
  }

  // ===== FHIR helpers =====
  function fhirGet(path) {
    return fetch(serverUrl + path, {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ===== Utility =====
  function getPatientName(p) {
    if (!p.name || !p.name.length) return 'Unknown';
    var n = p.name[0];
    if (n.text) return n.text;
    var parts = [];
    if (n.family) parts.push(n.family);
    if (n.given) parts = parts.concat(n.given);
    return parts.join(' ') || 'Unknown';
  }

  function formatDate(d) {
    if (!d) return 'N/A';
    try { return new Date(d).toLocaleDateString('zh-TW'); }
    catch(e) { return d; }
  }

  function calcAge(b) {
    if (!b) return 'N/A';
    var age = new Date().getFullYear() - new Date(b).getFullYear();
    return age + ' y/o';
  }

  function getPhone(p) {
    if (!p.telecom) return 'N/A';
    var phone = p.telecom.find(function(t) { return t.system === 'phone'; });
    return phone ? phone.value : 'N/A';
  }

  function infoBox(label, value) {
    return '<div class="info-box"><div class="label">' + label + '</div><div class="value">' + escHtml(value) + '</div></div>';
  }

  function errBox(e) {
    return '<div style="color:var(--accent-crit);padding:.75rem;font-size:.85rem;">' + escHtml(e.message) + '</div>';
  }

  function escHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ===== Doctor card =====
  window.renderDoctorCard = function() {
    var name = sessionStorage.getItem('uname') || 'Clinician';
    var email = sessionStorage.getItem('uemail') || '';
    var avatarUrl = 'https://api.dicebear.com/9.x/notionists/svg?seed=' + encodeURIComponent(name) + '&backgroundColor=e8eef5';
    var el = document.getElementById('doctorCard');
    if (!el) return;
    el.innerHTML = '<img src="' + avatarUrl + '" alt="">'
      + '<div class="doctor-info">'
      + '<div class="doctor-name">' + escHtml(name) + '</div>'
      + '<div class="doctor-role">' + escHtml(email) + '</div>'
      + '<div class="doctor-dept">\u4e3b\u6cbb\u91ab\u5e2b \u00b7 \u4e00\u822c\u5167\u79d1</div>'
      + '<div class="doctor-status"><span class="dot"></span> \u7dda\u4e0a</div>'
      + '</div>';
  }

  // ===== Logout =====
  window.doLogout = function() {
    sessionStorage.clear();
    location.href = 'index.html';
  };
})();
