document.addEventListener('DOMContentLoaded', async () => {
  const mainMenu       = document.getElementById('mainMenu');
  const createPanel    = document.getElementById('createPanel');
  const testPanel      = document.getElementById('testPanel');
  const statusPanel    = document.getElementById('statusPanel');

  const testProfileBtn     = document.getElementById('testProfileBtn');
  const backFromTest       = document.getElementById('backFromTest');
  const testUrlInput       = document.getElementById('testUrl');
  const testCriteriaInput  = document.getElementById('testCriteria');
  const runTestBtn         = document.getElementById('runTestBtn');

  const createWorkflowBtn  = document.getElementById('createWorkflowBtn');
  const runWorkflowBtn     = document.getElementById('runWorkflowBtn');
  const runWorkflowArrow   = document.getElementById('runWorkflowArrow');
  const workflowSubmenu    = document.getElementById('workflowSubmenu');
  const noWorkflows        = document.getElementById('noWorkflows');

  const backFromCreate     = document.getElementById('backFromCreate');
  const workflowNameInput  = document.getElementById('workflowName');
  const workflowCriteriaInput = document.getElementById('workflowCriteria');
  const saveWorkflowBtn    = document.getElementById('saveWorkflowBtn');

  const statusTitle   = document.getElementById('statusTitle');
  const statusMessage = document.getElementById('statusMessage');
  const progressFill  = document.getElementById('progressFill');
  const statusSub     = document.getElementById('statusSub');
  const stopBtn       = document.getElementById('stopBtn');

  let workflows = await loadWorkflows();
  renderSubmenu(workflows);

  // If a workflow is already running, jump straight to the status panel
  chrome.runtime.sendMessage({ action: 'getWorkflowState' }, (s) => {
    if (s && s.running) {
      statusTitle.textContent = s.workflow?.name ? `Running: ${s.workflow.name}` : 'Running Workflow';
      showStatus();
      applyProgress({
        message: `Checking lead ${s.currentIndex + 1} of ${s.totalUrls}`,
        current: s.currentIndex + 1,
        total: s.totalUrls,
      });
    }
  });

  // Progress updates streamed from the background service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== 'workflowProgress') return;

    if (statusPanel.style.display === 'none') showStatus();
    applyProgress(msg);

    if (msg.step === 'done' || msg.step === 'error') {
      setTimeout(showMainMenu, 2500);
    }
  });

  // ── Menu interactions ────────────────────────────────────────────────────

  testProfileBtn.addEventListener('click', () => {
    testUrlInput.value = '';
    testCriteriaInput.value = workflows[0]?.criteria || 'paralegal';
    testUrlInput.classList.remove('error');
    showTestPanel();
  });

  backFromTest.addEventListener('click', showMainMenu);

  runTestBtn.addEventListener('click', () => {
    const url = testUrlInput.value.trim();
    if (!url || !url.includes('linkedin.com/in/')) {
      testUrlInput.classList.add('error');
      testUrlInput.focus();
      return;
    }
    const criteria = testCriteriaInput.value.trim() || 'paralegal';
    statusTitle.textContent = 'Testing Profile';
    statusMessage.textContent = 'Opening profile...';
    progressFill.style.width = '0%';
    progressFill.style.background = '#2563eb';
    statusSub.textContent = url;
    stopBtn.disabled = true;
    showStatus();
    chrome.runtime.sendMessage({ action: 'testProfile', url, criteria });
  });

  testUrlInput.addEventListener('input', () => testUrlInput.classList.remove('error'));

  createWorkflowBtn.addEventListener('click', () => {
    workflowNameInput.value = '';
    workflowCriteriaInput.value = '';
    workflowNameInput.classList.remove('error');
    showCreatePanel();
  });

  runWorkflowBtn.addEventListener('click', () => {
    const open = workflowSubmenu.classList.toggle('open');
    runWorkflowArrow.classList.toggle('open', open);
  });

  backFromCreate.addEventListener('click', showMainMenu);

  saveWorkflowBtn.addEventListener('click', async () => {
    const name     = workflowNameInput.value.trim();
    const criteria = workflowCriteriaInput.value.trim();

    if (!name) {
      workflowNameInput.classList.add('error');
      workflowNameInput.focus();
      return;
    }

    workflows.push({ id: Date.now().toString(), name, criteria, createdAt: new Date().toISOString() });
    await saveWorkflows(workflows);
    renderSubmenu(workflows);
    showMainMenu();
  });

  workflowNameInput.addEventListener('input', () => {
    workflowNameInput.classList.remove('error');
  });

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopWorkflow' });
    statusMessage.textContent = 'Stopping...';
    stopBtn.disabled = true;
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function renderSubmenu(list) {
    workflowSubmenu.querySelectorAll('.submenu-item').forEach(el => el.remove());

    if (list.length === 0) {
      noWorkflows.style.display = 'block';
      return;
    }

    noWorkflows.style.display = 'none';
    list.forEach(wf => {
      const item = document.createElement('div');
      item.className = 'submenu-item';
      item.textContent = wf.name;
      item.addEventListener('click', () => startWorkflow(wf));
      workflowSubmenu.appendChild(item);
    });
  }

  async function startWorkflow(workflow) {
    const tabs = await chrome.tabs.query({ url: 'https://app.heyreach.io/*' });

    if (!tabs.length) {
      alert('No heyreach.io leads page is open. Please navigate there first.');
      return;
    }

    const tab = tabs[0];
    statusTitle.textContent = `Running: ${workflow.name}`;
    statusMessage.textContent = 'Starting...';
    progressFill.style.width = '0%';
    progressFill.style.background = '#2563eb';
    statusSub.textContent = '';
    stopBtn.disabled = false;
    showStatus();

    chrome.runtime.sendMessage({ action: 'runWorkflow', workflow, tabId: tab.id });
  }

  function applyProgress({ step, message, current, total }) {
    if (message) statusMessage.textContent = message;

    if (current != null && total) {
      const pct = Math.round((current / total) * 100);
      progressFill.style.width = `${pct}%`;
      statusSub.textContent = `${current} / ${total}`;
    }

    if (step === 'done') {
      progressFill.style.width = '100%';
      progressFill.style.background = '#16a34a';
    } else if (step === 'error') {
      progressFill.style.background = '#dc2626';
    }
  }

  function showMainMenu() {
    mainMenu.style.display    = 'block';
    createPanel.style.display = 'none';
    testPanel.style.display   = 'none';
    statusPanel.style.display = 'none';
  }

  function showCreatePanel() {
    mainMenu.style.display    = 'none';
    createPanel.style.display = 'block';
    testPanel.style.display   = 'none';
    statusPanel.style.display = 'none';
  }

  function showTestPanel() {
    mainMenu.style.display    = 'none';
    createPanel.style.display = 'none';
    testPanel.style.display   = 'block';
    statusPanel.style.display = 'none';
  }

  function showStatus() {
    mainMenu.style.display    = 'none';
    createPanel.style.display = 'none';
    testPanel.style.display   = 'none';
    statusPanel.style.display = 'block';
  }

  function loadWorkflows() {
    return new Promise(resolve => {
      chrome.storage.local.get('workflows', data => resolve(data.workflows || []));
    });
  }

  function saveWorkflows(list) {
    return new Promise(resolve => {
      chrome.storage.local.set({ workflows: list }, resolve);
    });
  }
});
