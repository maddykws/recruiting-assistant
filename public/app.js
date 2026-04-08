/* ======================================================
   Healthcare Recruiting Assistant — Frontend JS
   ====================================================== */

let candidateCount = 0;
let isSearching = false;
let currentEventSource = null;

// Source state tracking
const sourceState = {
  npi: { count: 0, status: 'idle' },
  doximity: { count: 0, status: 'idle' },
  healthgrades: { count: 0, status: 'idle' },
};

/* ---- SEARCH ---- */

async function searchCandidates() {
  const jd = document.getElementById('jd-input').value.trim();

  if (!jd) {
    showToast('Please paste a job description first.', 'error');
    return;
  }

  if (jd.length < 20) {
    showToast('Job description is too short. Please provide more detail.', 'error');
    return;
  }

  if (isSearching) return;

  // Reset UI
  resetUI();
  setSearching(true);

  // Cancel any existing SSE connection
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  try {
    // POST the JD to kick off the search (server returns SSE stream)
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jd }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(err.error || `Server error ${response.status}`);
    }

    // Read SSE stream from the response body
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);
          handleEvent(event);
        } catch (e) {
          console.warn('Failed to parse SSE event:', jsonStr);
        }
      }
    }

  } catch (err) {
    if (err.name !== 'AbortError') {
      addStatusEntry(`Error: ${err.message}`, true);
      showToast(`Search failed: ${err.message}`, 'error');
    }
  } finally {
    setSearching(false);
  }
}

/* ---- EVENT HANDLER ---- */

function handleEvent(event) {
  switch (event.type) {
    case 'status':
      handleStatusEvent(event);
      break;

    case 'candidate':
      addCandidateRow(event.candidate);
      break;

    case 'done':
      addStatusEntry(`Search complete — ${event.total} candidates found`, false);
      showToast(`Found ${event.total} candidates`, 'success');
      if (event.parsed_jd) {
        addStatusEntry(`Role: ${event.parsed_jd.job_title} | ${event.parsed_jd.location || 'Any location'}`, false);
      }
      setSearching(false);
      // Update source indicators to "done" if they were searching
      ['npi', 'doximity', 'healthgrades'].forEach(src => {
        if (sourceState[src].status === 'searching') {
          updateSourceStatus(src, 'done');
        }
      });
      break;

    case 'error':
      addStatusEntry(`Error: ${event.message}`, true);
      showToast(event.message, 'error');
      break;
  }
}

function handleStatusEvent(event) {
  const msg = event.message || '';
  const src = event.source;

  addStatusEntry(msg, false);

  // Detect NPI status
  if (src === 'npi' || msg.toLowerCase().includes('npi')) {
    const countMatch = msg.match(/(\d+)\s+provider/i);
    if (countMatch) {
      sourceState.npi.count = parseInt(countMatch[1]);
      updateSourceStatus('npi', 'done', `${sourceState.npi.count} found`);
    } else if (msg.toLowerCase().includes('searching') || msg.toLowerCase().includes('search')) {
      updateSourceStatus('npi', 'searching', 'searching...');
    } else if (msg.toLowerCase().includes('error')) {
      updateSourceStatus('npi', 'error', 'error');
    }
  }

  // Detect Doximity status
  if (src === 'doximity' || msg.toLowerCase().includes('doximity')) {
    const countMatch = msg.match(/(\d+)\s+profile/i);
    if (countMatch) {
      sourceState.doximity.count = parseInt(countMatch[1]);
      updateSourceStatus('doximity', 'done', `${sourceState.doximity.count} found`);
    } else if (msg.toLowerCase().includes('searching') || msg.toLowerCase().includes('search') || msg.toLowerCase().includes('x-ray')) {
      updateSourceStatus('doximity', 'searching', 'searching...');
    } else if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('unavailable')) {
      updateSourceStatus('doximity', 'error', 'unavailable');
    }
  }

  // Detect Healthgrades status
  if (src === 'healthgrades' || msg.toLowerCase().includes('healthgrades')) {
    const countMatch = msg.match(/(\d+)\s+(?:provider|doctor)/i);
    if (countMatch) {
      sourceState.healthgrades.count = parseInt(countMatch[1]);
      updateSourceStatus('healthgrades', 'done', `${sourceState.healthgrades.count} found`);
    } else if (msg.toLowerCase().includes('searching') || msg.toLowerCase().includes('search')) {
      updateSourceStatus('healthgrades', 'searching', 'searching...');
    } else if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('denied')) {
      updateSourceStatus('healthgrades', 'error', 'blocked');
    }
  }
}

/* ---- CANDIDATE ROW ---- */

function addCandidateRow(candidate) {
  const tbody = document.getElementById('results-tbody');
  const table = document.getElementById('results-table');
  const emptyState = document.getElementById('empty-state');

  // Show table, hide empty state
  if (candidateCount === 0) {
    table.style.display = 'table';
    emptyState.style.display = 'none';
  }

  candidateCount++;
  updateResultsCount(candidateCount);

  const tr = document.createElement('tr');

  // Score badge class
  const score = candidate.score;
  let scoreClass = 'low';
  if (score >= 7) scoreClass = 'high';
  else if (score >= 4) scoreClass = 'medium';

  // Build profile links
  let linksHtml = '';
  if (candidate.doximity_url) {
    linksHtml += `<a class="profile-link" href="${escapeHtml(candidate.doximity_url)}" target="_blank" rel="noopener">
      <span>📋</span> Doximity
    </a>`;
  }
  if (candidate.healthgrades_url) {
    linksHtml += `<a class="profile-link" href="${escapeHtml(candidate.healthgrades_url)}" target="_blank" rel="noopener">
      <span>⭐</span> Healthgrades${candidate.rating ? ` (${candidate.rating})` : ''}
    </a>`;
  }
  if (!linksHtml) linksHtml = '<span style="color:var(--text-muted);font-size:11px;">—</span>';

  // Phone with copy button
  const phoneHtml = candidate.phone
    ? `<div class="phone-cell">
        <span>${escapeHtml(candidate.phone)}</span>
        <button class="copy-btn" title="Copy phone" onclick="copyToClipboard(this, '${escapeHtml(candidate.phone)}')">⎘</button>
       </div>
       <span class="phone-label">Practice Phone</span>`
    : '<span style="color:var(--text-muted);">—</span>';

  // Credential badge
  const credHtml = candidate.credential
    ? `<span class="credential-badge">${escapeHtml(candidate.credential)}</span>`
    : '';

  // Source badge
  const sourceClass = (candidate.source || 'npi').replace(/-/g, '');
  const sourceLabel = {
    npi: 'NPI',
    doximity: 'Doximity',
    'doximity-xray': 'Dox/GX',
    healthgrades: 'HG',
  }[candidate.source] || candidate.source || '?';

  tr.innerHTML = `
    <td style="color:var(--text-muted);font-size:12px;">${candidateCount}</td>
    <td>
      <div class="candidate-name">${escapeHtml(candidate.full_name)}${credHtml}</div>
      ${candidate.npi ? `<div class="candidate-sub">NPI: ${escapeHtml(candidate.npi)}</div>` : ''}
      ${candidate.hospital_affiliation ? `<div class="candidate-sub">${escapeHtml(candidate.hospital_affiliation)}</div>` : ''}
    </td>
    <td>
      <div>${escapeHtml(candidate.specialty || '—')}</div>
    </td>
    <td>
      <div>${escapeHtml([candidate.city, candidate.state].filter(Boolean).join(', ') || '—')}</div>
    </td>
    <td>${phoneHtml}</td>
    <td>
      <span class="score-badge ${scoreClass}">${score != null ? score : '—'}</span>
    </td>
    <td>
      <div class="match-reason">${escapeHtml(candidate.match_reason || '—')}</div>
    </td>
    <td>
      <div class="profile-links">${linksHtml}</div>
    </td>
    <td>
      <span class="source-badge ${candidate.source || 'npi'}">${sourceLabel}</span>
    </td>
  `;

  tbody.appendChild(tr);

  // Scroll to bottom if user is near bottom
  const container = document.querySelector('.results-container');
  const isNearBottom = container.scrollTop + container.clientHeight > container.scrollHeight - 100;
  if (isNearBottom || candidateCount <= 5) {
    tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* ---- STATUS LOG ---- */

function addStatusEntry(message, isError = false) {
  const container = document.getElementById('status-entries');

  // Remove "latest" class from previous entries
  container.querySelectorAll('.status-entry.latest').forEach(el => el.classList.remove('latest'));

  const entry = document.createElement('div');
  entry.className = `status-entry latest${isError ? ' error' : ''}`;
  if (isError) entry.style.color = 'var(--red)';
  entry.textContent = message;

  container.appendChild(entry);

  // Auto-scroll the log
  const log = document.getElementById('status-log');
  log.scrollTop = log.scrollHeight;

  // Trim old entries (keep last 50)
  const entries = container.querySelectorAll('.status-entry');
  if (entries.length > 50) {
    entries[0].remove();
  }
}

/* ---- SOURCE INDICATORS ---- */

function updateSourceStatus(source, status, countText = null) {
  const srcEl = document.getElementById(`src-${source}`);
  const countEl = document.getElementById(`src-${source}-count`);
  if (!srcEl) return;

  srcEl.className = `source-item ${status}`;
  if (countText && countEl) {
    countEl.textContent = countText;
  } else if (status === 'searching' && countEl) {
    countEl.textContent = '...';
  }

  sourceState[source].status = status;
}

/* ---- UI STATE ---- */

function setSearching(searching) {
  isSearching = searching;
  const btn = document.getElementById('search-btn');
  const spinner = document.getElementById('spinner');
  const btnText = document.getElementById('search-btn-text');

  btn.disabled = searching;
  spinner.classList.toggle('visible', searching);
  btnText.textContent = searching ? 'Searching...' : 'Search Candidates';
}

function updateResultsCount(count) {
  const el = document.getElementById('results-count');
  el.textContent = `${count} found`;
}

function resetUI() {
  // Clear table
  candidateCount = 0;
  document.getElementById('results-tbody').innerHTML = '';
  document.getElementById('results-table').style.display = 'none';
  document.getElementById('empty-state').style.display = 'block';
  updateResultsCount(0);

  // Clear status log
  document.getElementById('status-entries').innerHTML = '';

  // Reset source indicators
  ['npi', 'doximity', 'healthgrades'].forEach(src => {
    sourceState[src] = { count: 0, status: 'idle' };
    updateSourceStatus(src, 'idle');
    const countEl = document.getElementById(`src-${src}-count`);
    if (countEl) countEl.textContent = '—';
  });

  // Set sources to "searching" state
  ['npi', 'doximity', 'healthgrades'].forEach(src => {
    updateSourceStatus(src, 'searching', 'starting...');
  });
}

/* ---- EXPORT CSV ---- */

async function exportCSV() {
  try {
    const response = await fetch('/api/export/csv');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `candidates-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('CSV downloaded', 'success');
  } catch (err) {
    showToast(`Export failed: ${err.message}`, 'error');
  }
}

/* ---- COPY TO CLIPBOARD ---- */

function copyToClipboard(btn, text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    btn.textContent = '✓';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = '⎘';
    }, 1500);
  }).catch(() => {
    // Fallback for older browsers
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast('Copied!', 'info');
  });
}

/* ---- TOAST NOTIFICATIONS ---- */

let toastTimeout;

function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  clearTimeout(toastTimeout);

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = { success: '✅', error: '❌', info: 'ℹ️' }[type] || '·';
  toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;

  document.body.appendChild(toast);

  toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/* ---- UTILITIES ---- */

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ---- KEYBOARD SHORTCUTS ---- */

document.addEventListener('keydown', (e) => {
  // Ctrl+Enter to search
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!isSearching) searchCandidates();
  }

  // Escape to cancel (if searching)
  if (e.key === 'Escape' && isSearching) {
    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
    setSearching(false);
    addStatusEntry('Search cancelled by user.');
  }
});

// Focus textarea on load
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('jd-input').focus();
});
