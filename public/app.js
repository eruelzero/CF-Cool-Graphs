// Global chart instances to destroy them before re-rendering
let ratingOverlayChartInstance = null;
let performanceChartInstance = null;
let cumulativeChartInstance = null;
let rolling50ChartInstance = null;
let tag15ChartInstance = null;
let ratingBucketsChartInstance = null;
let attemptsChartInstance = null;
let tagsAcChartInstance = null;
let tagsErrorChartInstance = null;
let avgTimeChartInstance = null;
let activityTimeChartInstance = null;
let tagWeaknessChartInstance = null;
let upsolveTrackerChartInstance = null;


// Global state
let currentData = null;
let currentHandle = '';
let currentTab = 'rating-overlay';
let isCalculating = false;

// Element references
const searchForm = document.getElementById('search-form');
const handleInput = document.getElementById('handle-input');
const searchBtn = document.getElementById('search-btn');
const refreshBtn = document.getElementById('refresh-btn');
const errorBanner = document.getElementById('error-banner');
const errorMessage = document.getElementById('error-message');
const infoBanner = document.getElementById('info-banner');
const infoMessage = document.getElementById('info-message');
const dashboard = document.getElementById('dashboard');
const loadingSkeleton = document.getElementById('loading-skeleton');
const landingState = document.getElementById('landing-state');

// Profile card elements
const userAvatar = document.getElementById('user-avatar');
const userHandle = document.getElementById('user-handle');
const userRank = document.getElementById('user-rank');
const userRating = document.getElementById('user-rating');
const userMaxRating = document.getElementById('user-max-rating');
const userMaxRank = document.getElementById('user-max-rank');
const userTotalSolved = document.getElementById('user-total-solved');
const userOrg = document.getElementById('user-org');
const orgContainer = document.getElementById('org-container');

// Placeholder containers
const rolling50Canvas = document.getElementById('rolling50Chart');
const rolling50Placeholder = document.getElementById('rolling-50-placeholder');
const tag15Canvas = document.getElementById('tag15Chart');
const tag15Placeholder = document.getElementById('tag-15-placeholder');

// Form submit handler
searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const handle = handleInput.value.trim();
  if (handle) {
    await fetchAndRenderData(handle, false);
  }
});

// Force refresh handler
refreshBtn.addEventListener('click', async () => {
  const handle = handleInput.value.trim();
  if (handle) {
    await fetchAndRenderData(handle, true);
  }
});

// Tab Navigation click handlers
document.querySelectorAll('.nav-tab').forEach(tabBtn => {
  tabBtn.addEventListener('click', () => {
    const tabId = tabBtn.getAttribute('data-tab');
    if (tabId) {
      switchTab(tabId);
    }
  });
});

// Start performance calculations button handler
const startPerfCalcBtn = document.getElementById('start-perf-calc-btn');
if (startPerfCalcBtn) {
  startPerfCalcBtn.addEventListener('click', runPerformanceCalculation);
}

/**
 * Handles switching active tabs and lazily rendering the chart associated with it
 */
function switchTab(tabId) {
  currentTab = tabId;
  
  // Update tab button classes
  document.querySelectorAll('.nav-tab').forEach(btn => {
    if (btn.getAttribute('data-tab') === tabId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Hide all cards
  const cards = [
    'rating-overlay', 'performance', 'cumulative', 'rolling-50', 'heatmap',
    'rating-buckets', 'attempts', 'tags-ac', 'tags-error', 'tag-15',
    'avg-time', 'activity-time', 'tag-weakness', 'upsolve-tracker'
  ];
  cards.forEach(c => {
    const cardEl = document.getElementById(`card-${c}`);
    if (cardEl) {
      cardEl.classList.add('hidden');
    }
  });

  // Show active card
  const activeCardEl = document.getElementById(`card-${tabId}`);
  if (activeCardEl) {
    activeCardEl.classList.remove('hidden');
  }

  // Destroy all charts first to keep rendering fresh and clean
  destroyCharts();

  // Lazily render active chart if currentData is loaded
  if (currentData) {
    if (tabId === 'rating-overlay') {
      renderRatingOverlayChart(currentData.ratingHistory, currentData.solvedProblems);
    } else if (tabId === 'performance') {
      renderPerformanceChart(currentData.performances);
      updatePerfCalcUI();
    } else if (tabId === 'cumulative') {
      renderCumulativeChart(currentData.solvedProblems);
    } else if (tabId === 'rolling-50') {
      renderRolling50Chart(currentData.rollingAvg);
    } else if (tabId === 'heatmap') {
      renderHeatmap(currentData.heatmapData);
    } else if (tabId === 'rating-buckets') {
      renderRatingBucketsChart(currentData.ratingBuckets);
    } else if (tabId === 'attempts') {
      renderAttemptsChart(currentData.verdictsByRating);
    } else if (tabId === 'tags-ac') {
      renderTagsAcChart(currentData.tagsAc);
    } else if (tabId === 'tags-error') {
      renderTagsErrorChart(currentData.tagsError);
    } else if (tabId === 'tag-15') {
      renderTag15Chart(currentData.rollingTags);
    } else if (tabId === 'avg-time') {
      renderAvgTimeChart(currentData.avgSolveTime);
    } else if (tabId === 'activity-time') {
      renderActivityTimeChart(currentData.activityTime);
    } else if (tabId === 'tag-weakness') {
      renderTagWeaknessChart(currentData.tagWeakness);
    } else if (tabId === 'upsolve-tracker') {
      renderUpsolveTrackerChart(currentData.upsolveData);
    }
  }
}

/**
 * Updates UI progress bar, texts, and calculate button state in the Performance Calculation panel
 */
function updatePerfCalcUI() {
  const calcCard = document.getElementById('perf-calc-card');
  const progressFill = document.getElementById('perf-progress-fill');
  const progressText = document.getElementById('perf-progress-text');
  const startBtn = document.getElementById('start-perf-calc-btn');

  if (!currentData) {
    if (calcCard) calcCard.classList.add('hidden');
    return;
  }

  const calculated = currentData.performances
    ? currentData.performances.filter(p => p.participantType !== 'VIRTUAL' || p.isDateTaken === true).length
    : 0;
  const total = currentData.totalContestsCount || 0;

  if (total === 0 || calculated >= total) {
    if (calcCard) calcCard.classList.add('hidden');
    return;
  }

  if (calcCard) calcCard.classList.remove('hidden');

  const percent = Math.min(100, Math.round((calculated / total) * 100));
  if (progressFill) progressFill.style.width = `${percent}%`;
  if (progressText) progressText.textContent = `Calculated ${calculated} of ${total} contests (${percent}%)`;

  if (startBtn) {
    if (isCalculating) {
      startBtn.setAttribute('disabled', 'true');
      startBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Calculating...`;
    } else {
      startBtn.removeAttribute('disabled');
      startBtn.textContent = 'Calculate Performance';
    }
  }
}

/**
 * Runs the incremental loop calling backend performance calculations sequentially in batches of 3
 */
async function runPerformanceCalculation() {
  if (isCalculating || !currentData) return;

  isCalculating = true;
  updatePerfCalcUI();

  try {
    while (isCalculating) {
      const calculatedCount = currentData.performances
        ? currentData.performances.filter(p => p.participantType !== 'VIRTUAL' || p.isDateTaken === true).length
        : 0;
      if (calculatedCount >= currentData.totalContestsCount) {
        break;
      }

      const url = `/api/analysis?handle=${encodeURIComponent(currentHandle)}&calculatePerformances=true`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Performance calculation request failed');
      }
      const data = await response.json();
      
      const prevLength = currentData.performances
        ? currentData.performances.filter(p => p.participantType !== 'VIRTUAL' || p.isDateTaken === true).length
        : 0;
      
      // Update global currentData with new performances
      currentData.performances = data.performances;
      
      // Re-render chart and update UI
      if (currentTab === 'performance') {
        renderPerformanceChart(currentData.performances);
      }
      updatePerfCalcUI();

      const newLength = currentData.performances
        ? currentData.performances.filter(p => p.participantType !== 'VIRTUAL' || p.isDateTaken === true).length
        : 0;

      // If we didn't make progress (e.g. no new performances calculated), break
      if (newLength <= prevLength) {
        console.warn('Performance calculation loop stopped because no new performances were calculated.');
        break;
      }
    }
  } catch (err) {
    console.error(err);
    showErrorBanner(err.message || 'An error occurred during performance calculation.');
  } finally {
    isCalculating = false;
    updatePerfCalcUI();
  }
}

/**
 * Fetches analytics data from the Express backend and updates the UI
 */
async function fetchAndRenderData(handle, forceRefresh = false) {
  // Stop any active calculation loops
  isCalculating = false;

  setLoadingState(true);
  hideBanners();
  destroyCharts();

  try {
    const url = forceRefresh 
      ? `/api/analysis/refresh?handle=${encodeURIComponent(handle)}` 
      : `/api/analysis?handle=${encodeURIComponent(handle)}`;
    
    const method = forceRefresh ? 'POST' : 'GET';
    
    const response = await fetch(url, { method });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch analysis data');
    }

    // Cache the loaded profile data and handle globally
    currentData = data;
    currentHandle = handle;

    // Show source of data (in-memory, MongoDB, API) in the info banner
    const cacheSource = response.headers.get('X-Cache-Source') || 'server';
    showInfoBanner(cacheSource, handle);

    // Update profile layout
    updateProfileCard(data.profile, data.solvedProblems.length);

    // Switch view to Rating Overlay initially
    switchTab('rating-overlay');

    // Switch view
    loadingSkeleton.classList.add('hidden');
    dashboard.classList.remove('hidden');
    refreshBtn.removeAttribute('disabled');
  } catch (err) {
    console.error(err);
    showErrorBanner(err.message);
    
    currentData = null;
    currentHandle = '';

    // Fallback to landing state
    loadingSkeleton.classList.add('hidden');
    dashboard.classList.add('hidden');
    landingState.classList.remove('hidden');
  } finally {
    setLoadingState(false);
  }
}

/**
 * Sets loading spinners and locks inputs
 */
function setLoadingState(isLoading) {
  if (isLoading) {
    searchBtn.classList.add('loading');
    searchBtn.setAttribute('disabled', 'true');
    handleInput.setAttribute('disabled', 'true');
    refreshBtn.setAttribute('disabled', 'true');
    
    landingState.classList.add('hidden');
    dashboard.classList.add('hidden');
    loadingSkeleton.classList.remove('hidden');
  } else {
    searchBtn.classList.remove('loading');
    searchBtn.removeAttribute('disabled');
    handleInput.removeAttribute('disabled');
  }
}

function hideBanners() {
  errorBanner.classList.add('hidden');
  infoBanner.classList.add('hidden');
}

function showErrorBanner(message) {
  errorMessage.textContent = message;
  errorBanner.classList.remove('hidden');
}

function showInfoBanner(source, handle) {
  let sourceText = '';
  switch (source) {
    case 'memory-cache':
      sourceText = 'Loaded from server in-memory cache (5-minute TTL).';
      break;
    case 'mongodb-cache':
      sourceText = 'Loaded from database cache.';
      break;
    case 'mongodb-cache-stale-fallback':
      sourceText = 'Codeforces API down. Serving offline database cache.';
      break;
    case 'codeforces-api':
      sourceText = 'Freshly queried from Codeforces API and cached.';
      break;
    default:
      sourceText = 'Query completed successfully.';
  }
  infoMessage.textContent = `[${handle}] ${sourceText}`;
  infoBanner.classList.remove('hidden');
}

/**
 * Maps Codeforces rank strings to tailored CSS themes
 */
function getRankClass(rank) {
  if (!rank) return '';
  const r = rank.toLowerCase().replace(/\s+/g, '-');
  if (r.includes('candidate-master')) return 'cf-rank-candidate-master';
  if (r.includes('master')) return 'cf-rank-master';
  if (r.includes('grandmaster')) return 'cf-rank-grandmaster';
  if (r.includes('newbie')) return 'cf-rank-newbie';
  if (r.includes('pupil')) return 'cf-rank-pupil';
  if (r.includes('specialist')) return 'cf-rank-specialist';
  if (r.includes('expert')) return 'cf-rank-expert';
  return '';
}

/**
 * Capitalizes a rank string (e.g. "candidate master" -> "Candidate Master")
 */
function capitalizeRank(rank) {
  if (!rank) return '';
  return rank.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * Updates the user details cards with API data
 */
function updateProfileCard(profile, totalSolved) {
  userAvatar.src = profile.titlePhoto || profile.avatar || 'https://userpic.codeforces.org/no-title.jpg';
  userHandle.textContent = profile.handle;
  userRating.textContent = profile.rating || 'Unrated';
  userMaxRating.textContent = profile.maxRating || 'Unrated';
  userMaxRank.textContent = capitalizeRank(profile.maxRank) || 'None';
  userTotalSolved.textContent = totalSolved.toLocaleString();

  // Reset and set rank badge
  userRank.textContent = capitalizeRank(profile.rank) || 'Unrated';
  userRank.className = 'rank-badge'; // Reset classes
  if (profile.rank) {
    userRank.classList.add(getRankClass(profile.rank));
  }

  // Set Organization
  if (profile.organization) {
    userOrg.textContent = profile.organization;
    orgContainer.classList.remove('hidden');
  } else {
    orgContainer.classList.add('hidden');
  }
}

/**
 * Destroys all current Chart.js instances to avoid memory leaks
 */
function destroyCharts() {
  if (ratingOverlayChartInstance) ratingOverlayChartInstance.destroy();
  if (performanceChartInstance) performanceChartInstance.destroy();
  if (cumulativeChartInstance) cumulativeChartInstance.destroy();
  if (rolling50ChartInstance) rolling50ChartInstance.destroy();
  if (tag15ChartInstance) tag15ChartInstance.destroy();
  if (ratingBucketsChartInstance) ratingBucketsChartInstance.destroy();
  if (attemptsChartInstance) attemptsChartInstance.destroy();
  if (tagsAcChartInstance) tagsAcChartInstance.destroy();
  if (tagsErrorChartInstance) tagsErrorChartInstance.destroy();
  if (avgTimeChartInstance) avgTimeChartInstance.destroy();
  if (activityTimeChartInstance) activityTimeChartInstance.destroy();
  if (tagWeaknessChartInstance) tagWeaknessChartInstance.destroy();
  if (upsolveTrackerChartInstance) upsolveTrackerChartInstance.destroy();
  
  ratingOverlayChartInstance = null;
  performanceChartInstance = null;
  cumulativeChartInstance = null;
  rolling50ChartInstance = null;
  tag15ChartInstance = null;
  ratingBucketsChartInstance = null;
  attemptsChartInstance = null;
  tagsAcChartInstance = null;
  tagsErrorChartInstance = null;
  avgTimeChartInstance = null;
  activityTimeChartInstance = null;
  tagWeaknessChartInstance = null;
  upsolveTrackerChartInstance = null;
}

// Chart.js Default styling tweaks (Light Theme)
Chart.defaults.color = '#607d8b';
Chart.defaults.font.family = "'Open Sans', 'Segoe UI', sans-serif";
Chart.defaults.borderColor = 'rgba(0, 0, 0, 0.08)';

// Rating band definitions matching Codeforces rank colors
const RATING_BANDS = [
  { min: 0,    max: 1200, color: 'rgba(128,128,128,0.07)', label: 'Newbie' },
  { min: 1200, max: 1400, color: 'rgba(0,128,0,0.09)',     label: 'Pupil' },
  { min: 1400, max: 1600, color: 'rgba(3,168,158,0.09)',   label: 'Specialist' },
  { min: 1600, max: 1900, color: 'rgba(0,0,255,0.07)',     label: 'Expert' },
  { min: 1900, max: 2100, color: 'rgba(170,0,170,0.07)',   label: 'CM' },
  { min: 2100, max: 2400, color: 'rgba(255,140,0,0.07)',   label: 'Master' },
  { min: 2400, max: 4000, color: 'rgba(255,0,0,0.07)',     label: 'GM+' }
];

const ratingBandsPlugin = {
  id: 'ratingBands',
  beforeDraw(chart, args, options) {
    if (!options || !options.display) return;
    const { ctx, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
    if (!y) return;
    
    ctx.save();
    RATING_BANDS.forEach(band => {
      const yTop = y.getPixelForValue(band.max);
      const yBottom = y.getPixelForValue(band.min);
      // Clamp to chart area
      const drawTop = Math.max(yTop, top);
      const drawBottom = Math.min(yBottom, bottom);
      if (drawTop < drawBottom) {
        ctx.fillStyle = band.color;
        ctx.fillRect(left, drawTop, right - left, drawBottom - drawTop);
      }
    });
    ctx.restore();
  }
};

Chart.register(ratingBandsPlugin);

// Zoom plugin configuration helper
function getZoomOptions(chartInstanceVarName) {
  // Only the Tag Weakness bubble chart zooms in both directions (xy)
  const mode = (chartInstanceVarName === 'tagWeaknessChartInstance') ? 'xy' : 'x';

  const limitsConfig = {
    x: { min: 'original', max: 'original' }
  };

  if (chartInstanceVarName === 'tagWeaknessChartInstance') {
    limitsConfig.y = { min: 0, max: 100 }; // Bounded between 0% and 100% accuracy
  } else {
    limitsConfig.y = { min: 'original', max: 'original' };
  }

  return {
    zoom: {
      wheel: {
        enabled: true,
        modifierKey: 'ctrl',
        speed: 0.04 // Smooth, low-velocity zoom increments
      },
      pinch: { enabled: true },
      mode: mode,
      onZoom: () => { showResetZoomBtn(chartInstanceVarName); }
    },
    pan: {
      enabled: true,
      mode: mode,
      modifierKey: 'ctrl',
      onPan: () => { showResetZoomBtn(chartInstanceVarName); }
    },
    limits: limitsConfig
  };
}

function showResetZoomBtn(chartVarName) {
  // Find the reset button in the active chart card
  const activeCard = document.querySelector('.chart-card:not(.hidden)');
  if (activeCard) {
    const btn = activeCard.querySelector('.reset-zoom-btn');
    if (btn) btn.classList.add('visible');
  }
}

// Global event listener for reset-zoom buttons
document.addEventListener('click', (e) => {
  if (e.target.closest('.reset-zoom-btn')) {
    // Find the active chart instance and reset
    const allInstances = [
      ratingOverlayChartInstance, performanceChartInstance, cumulativeChartInstance,
      rolling50ChartInstance, tag15ChartInstance, ratingBucketsChartInstance,
      attemptsChartInstance, tagsAcChartInstance, tagsErrorChartInstance,
      avgTimeChartInstance, activityTimeChartInstance, tagWeaknessChartInstance,
      upsolveTrackerChartInstance
    ];
    allInstances.forEach(inst => {
      if (inst) {
        try { inst.resetZoom(); } catch(e) {}
      }
    });
    e.target.closest('.reset-zoom-btn').classList.remove('visible');
  }
});

/**
 * Renders Chart 1: Cumulative Solved Problems
 */
function renderCumulativeChart(solvedProblems) {
  const canvas = document.getElementById('cumulativeChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const ctx = canvas.getContext('2d');
  
  const chartData = solvedProblems.map((prob, index) => ({
    x: prob.creationTimeSeconds * 1000,
    y: index + 1
  }));

  cumulativeChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Cumulative Solves',
        data: chartData,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (val) => new Date(val).toLocaleDateString(),
            maxTicksLimit: 8
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        },
        y: {
          title: {
            display: true,
            text: 'Unique Problems Solved',
            color: '#607d8b'
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        }
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].raw.x).toLocaleDateString(),
            label: (item) => `Total Solves: ${item.raw.y}`
          }
        },
        zoom: getZoomOptions('cumulativeChartInstance')
      }
    }
  });
}

/**
 * Renders Chart 2: 50-Problem Rolling Average
 */
function renderRolling50Chart(rollingAvg) {
  const canvas = rolling50Canvas;
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const placeholder = rolling50Placeholder;

  if (!rollingAvg || rollingAvg.length < 50) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    return;
  }

  canvas.classList.remove('hidden');
  placeholder.classList.add('hidden');

  const chartData = rollingAvg.map(item => ({
    x: item.time * 1000,
    y: Math.round(item.avg_rating)
  }));

  const ctx = canvas.getContext('2d');
  rolling50ChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Rolling Average Rating',
        data: chartData,
        borderColor: '#8b5cf6',
        backgroundColor: 'rgba(139, 92, 246, 0.1)',
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (val) => new Date(val).toLocaleDateString(),
            maxTicksLimit: 8
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        },
        y: {
          title: {
            display: true,
            text: 'Average Rating Difficulty',
            color: '#607d8b'
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        }
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].raw.x).toLocaleDateString(),
            label: (item) => `Average Rating: ${item.raw.y}`
          }
        },
        ratingBands: { display: true },
        zoom: getZoomOptions('rolling50ChartInstance')
      }
    }
  });
}

/**
 * Renders Chart 3: 15-Problem Tag Rolling Average for tags with >30 solves
 */
function renderTag15Chart(rollingTags) {
  const canvas = tag15Canvas;
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const placeholder = tag15Placeholder;

  if (!rollingTags || Object.keys(rollingTags).length === 0) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    return;
  }

  canvas.classList.remove('hidden');
  placeholder.classList.add('hidden');

  // Modern high-contrast color scheme for distinct tags
  const tagColors = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#d32f2f', // red
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#06b6d4', // cyan
    '#14b8a6', // teal
    '#f43f5e', // rose
    '#fb923c', // orange
    '#a78bfa'  // light purple
  ];

  let index = 0;
  const datasets = [];
  for (const [tag, points] of Object.entries(rollingTags)) {
    const chartData = points.map(item => ({
      x: item.time * 1000,
      y: Math.round(item.avg_rating)
    }));

    const color = tagColors[index % tagColors.length];
    index++;

    datasets.push({
      label: tag,
      data: chartData,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2.2,
      pointRadius: 0,
      fill: false,
      tension: 0
    });
  }

  const ctx = canvas.getContext('2d');
  tag15ChartInstance = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        axis: 'x',
        intersect: false
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (val) => new Date(val).toLocaleDateString(),
            maxTicksLimit: 10
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        },
        y: {
          title: {
            display: true,
            text: 'Average Rating Difficulty',
            color: '#607d8b'
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        }
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            boxWidth: 12,
            boxHeight: 6,
            padding: 15,
            font: {
              size: 11
            }
          }
        },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].raw.x).toLocaleDateString(),
            label: (item) => `${item.dataset.label}: ${item.raw.y}`
          }
        },
        ratingBands: { display: true },
        zoom: getZoomOptions('tag15ChartInstance')
      }
    }
  });
}

/**
 * Renders Chart 1: Rating Overlay (Rating & Max Solved Difficulty)
 */
function renderRatingOverlayChart(ratingHistory, solvedProblems) {
  const canvas = document.getElementById('ratingOverlayChart');
  if (!canvas) return;
  const placeholder = document.getElementById('rating-overlay-placeholder');
  
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  
  if (!ratingHistory || ratingHistory.length === 0) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    return;
  }
  
  canvas.classList.remove('hidden');
  placeholder.classList.add('hidden');
  
  const ratingLineData = ratingHistory.map(rc => ({
    x: rc.ratingUpdateTimeSeconds * 1000,
    y: rc.newRating,
    contestName: rc.contestName,
    rank: rc.rank
  }));
  
  const maxSolvedData = [];
  for (const rc of ratingHistory) {
    const maxVal = rc.maxSolvedRating;
    if (maxVal !== null && maxVal !== undefined) {
      maxSolvedData.push({
        x: rc.ratingUpdateTimeSeconds * 1000,
        y: maxVal,
        contestName: rc.contestName
      });
    }
  }
  
  const ctx = canvas.getContext('2d');
  
  ratingOverlayChartInstance = new Chart(ctx, {
    data: {
      datasets: [
        {
          type: 'line',
          label: 'Official Rating',
          data: ratingLineData,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2.5,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: '#3b82f6',
          fill: true,
          tension: 0
        },
        {
          type: 'line',
          label: 'Max Solved Problem Difficulty',
          data: maxSolvedData,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#f59e0b',
          fill: false,
          tension: 0,
          showLine: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (val) => new Date(val).toLocaleDateString(),
            maxTicksLimit: 8
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        },
        y: {
          title: {
            display: true,
            text: 'Rating / Difficulty',
            color: '#607d8b'
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        }
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            font: {
              size: 11
            }
          }
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (items.length > 0) {
                const item = items[0];
                return new Date(item.raw.x).toLocaleDateString();
              }
              return '';
            },
            label: (item) => {
              const raw = item.raw;
              if (item.datasetIndex === 0) {
                return [
                  `Contest: ${raw.contestName}`,
                  `Official Rank: ${raw.rank}`,
                  `New Rating: ${raw.y}`
                ];
              } else {
                return [
                  `Contest: ${raw.contestName}`,
                  `Max Solved Difficulty: ${raw.y}`
                ];
              }
            }
          }
        },
        ratingBands: { display: true },
        zoom: getZoomOptions('ratingOverlayChartInstance')
      }
    }
  });
}

/**
 * Renders Chart 2: Performance History (Official vs. Virtual)
 */
function renderPerformanceChart(performances) {
  const canvas = document.getElementById('performanceChart');
  if (!canvas) return;
  const placeholder = document.getElementById('performance-placeholder');
  
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  
  if (!performances || performances.length === 0) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    return;
  }
  
  canvas.classList.remove('hidden');
  placeholder.classList.add('hidden');
  
  const officialData = performances
    .filter(p => p.participantType === 'OFFICIAL' && p.performance > 0)
    .map(p => ({
      x: p.ratingUpdateTimeSeconds * 1000,
      y: p.performance,
      contestName: p.contestName,
      rank: p.rank,
      wasFallbackUsed: p.wasFallbackUsed
    }));
    
  const virtualData = performances
    .filter(p => p.participantType === 'VIRTUAL' && p.performance > 0)
    .map(p => ({
      x: p.ratingUpdateTimeSeconds * 1000,
      y: p.performance,
      contestName: p.contestName,
      rank: p.rank,
      wasFallbackUsed: p.wasFallbackUsed
    }));
    
  const ctx = canvas.getContext('2d');
  const datasets = [];
  
  if (officialData.length > 0) {
    datasets.push({
      type: 'line',
      label: 'Official Performance',
      data: officialData,
      borderColor: '#8b5cf6',
      backgroundColor: 'rgba(139, 92, 246, 0.1)',
      borderWidth: 2.5,
      pointStyle: 'circle',
      pointRadius: 3.5,
      pointHoverRadius: 5.5,
      pointBackgroundColor: (ctx) => (ctx.raw && ctx.raw.wasFallbackUsed ? '#64748b' : '#8b5cf6'),
      pointBorderColor: (ctx) => (ctx.raw && ctx.raw.wasFallbackUsed ? '#64748b' : '#8b5cf6'),
      fill: true,
      tension: 0
    });
  }
  
  if (virtualData.length > 0) {
    datasets.push({
      type: 'line',
      label: 'Virtual Performance (Approx.)',
      data: virtualData,
      borderColor: 'rgba(139, 92, 246, 0.5)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [6, 6],
      pointStyle: 'circle',
      pointRadius: 3.5,
      pointHoverRadius: 5.5,
      pointBackgroundColor: (ctx) => (ctx.raw && ctx.raw.wasFallbackUsed ? '#64748b' : 'rgba(139, 92, 246, 0.5)'),
      pointBorderColor: (ctx) => (ctx.raw && ctx.raw.wasFallbackUsed ? '#64748b' : 'rgba(139, 92, 246, 0.5)'),
      fill: false,
      tension: 0
    });
  }
  
  performanceChartInstance = new Chart(ctx, {
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (val) => new Date(val).toLocaleDateString(),
            maxTicksLimit: 8
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        },
        y: {
          title: {
            display: true,
            text: 'Performance Rating',
            color: '#607d8b'
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)'
          }
        }
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            font: {
              size: 11
            }
          }
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (items.length > 0) {
                const item = items[0];
                return new Date(item.raw.x).toLocaleDateString();
              }
              return '';
            },
            label: (item) => {
              const raw = item.raw;
              const isVirtual = item.dataset.label.includes('Virtual');
              const lines = [
                `Contest: ${raw.contestName}`,
                `Rank: ${raw.rank}`,
                `Performance: ${raw.y}`
              ];
              if (raw.wasFallbackUsed) {
                lines.push('(Approximate Fallback)');
              } else if (isVirtual) {
                lines.push('(Estimated value)');
              }
              return lines;
            }
          }
        },
        ratingBands: { display: true },
        zoom: getZoomOptions('performanceChartInstance')
      }
    }
  });
}

/**
 * Helper to determine CSS color based on difficulty rating
 */
function getColorForRating(rating) {
  if (!rating || rating === 0) return 'rgba(0, 0, 0, 0.03)';
  if (rating < 1200) return '#cccccc';
  if (rating < 1400) return '#008000';
  if (rating < 1600) return '#03a89e';
  if (rating < 1900) return '#0000ff';
  if (rating < 2100) return '#aa00aa';
  if (rating < 2400) return '#ff8c00';
  return '#ff0000';
}

/**
 * Renders HTML/CSS calendar heatmap inside #heatmap-grid
 */
function renderHeatmap(heatmapData) {
  const gridEl = document.getElementById('heatmap-grid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  const today = new Date();
  const startDate = new Date();
  startDate.setDate(today.getDate() - 364); // 52 weeks * 7 days
  const startDayOfWeek = startDate.getDay();
  // Adjust to start on Sunday
  startDate.setDate(startDate.getDate() - startDayOfWeek);

  const tempDate = new Date(startDate);
  while (tempDate <= today) {
    const year = tempDate.getFullYear();
    const month = String(tempDate.getMonth() + 1).padStart(2, '0');
    const day = String(tempDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const rating = heatmapData ? (heatmapData[dateStr] || 0) : 0;
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';
    cell.style.backgroundColor = rating > 0 ? getColorForRating(rating) : '#e0e5ea';
    
    const dateOptions = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
    const formattedDate = tempDate.toLocaleDateString(undefined, dateOptions);
    const ratingText = rating > 0 ? `Max Solved: ${rating}` : 'No solved problems';
    cell.title = `${formattedDate}\n${ratingText}`;
    
    gridEl.appendChild(cell);
    tempDate.setDate(tempDate.getDate() + 1);
  }
}

/**
 * Renders stacked vertical bar chart for Rating Buckets
 */
function renderRatingBucketsChart(ratingBuckets) {
  const canvas = document.getElementById('ratingBucketsChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const ctx = canvas.getContext('2d');
  
  const labels = ratingBuckets.map(item => item[0]);
  const contestData = ratingBuckets.map(item => item[1].Contest);
  const virtualData = ratingBuckets.map(item => item[1].Virtual);
  const practiceData = ratingBuckets.map(item => item[1].Practice);

  ratingBucketsChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Contest',
          data: contestData,
          backgroundColor: '#8b5cf6',
          stack: 'solved'
        },
        {
          label: 'Virtual',
          data: virtualData,
          backgroundColor: '#fb923c',
          stack: 'solved'
        },
        {
          label: 'Practice',
          data: practiceData,
          backgroundColor: '#10b981',
          stack: 'solved'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          title: { display: true, text: 'Problem Rating', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' }
        },
        y: {
          stacked: true,
          title: { display: true, text: 'Solves Count', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' }
        }
      },
      plugins: {
        legend: { display: true, position: 'top' },
        zoom: getZoomOptions('ratingBucketsChartInstance')
      }
    }
  });
}

/**
 * Renders 100% stacked vertical bar chart for Verdict Breakdown
 */
function renderAttemptsChart(verdictsByRating) {
  const canvas = document.getElementById('attemptsChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const ctx = canvas.getContext('2d');
  
  const labels = verdictsByRating.map(item => item[0]);
  const acData = [];
  const waData = [];
  const tleData = [];
  const mleData = [];
  const otherData = [];
  
  verdictsByRating.forEach(item => {
    const total = item[1].total || 1;
    acData.push(((item[1].AC || 0) / total) * 100);
    waData.push(((item[1].WA || 0) / total) * 100);
    tleData.push(((item[1].TLE || 0) / total) * 100);
    mleData.push(((item[1].MLE || 0) / total) * 100);
    otherData.push(((item[1].Other || 0) / total) * 100);
  });

  attemptsChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'AC', data: acData, backgroundColor: '#10b981', stack: 'verdict' },
        { label: 'WA', data: waData, backgroundColor: '#d32f2f', stack: 'verdict' },
        { label: 'TLE', data: tleData, backgroundColor: '#f59e0b', stack: 'verdict' },
        { label: 'MLE', data: mleData, backgroundColor: '#a78bfa', stack: 'verdict' },
        { label: 'Other', data: otherData, backgroundColor: '#64748b', stack: 'verdict' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          title: { display: true, text: 'Problem Rating', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' }
        },
        y: {
          stacked: true,
          max: 100,
          title: { display: true, text: 'Percentage (%)', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' },
          ticks: {
            callback: (val) => `${val}%`
          }
        }
      },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          callbacks: {
            label: (item) => {
              const ratingData = verdictsByRating[item.dataIndex][1];
              const val = item.raw.toFixed(1);
              let count = 0;
              if (item.dataset.label === 'AC') count = ratingData.AC;
              else if (item.dataset.label === 'WA') count = ratingData.WA;
              else if (item.dataset.label === 'TLE') count = ratingData.TLE;
              else if (item.dataset.label === 'MLE') count = ratingData.MLE;
              else if (item.dataset.label === 'Other') count = ratingData.Other;
              return `${item.dataset.label}: ${val}% (${count} / ${ratingData.total} attempts)`;
            }
          }
        },
        zoom: getZoomOptions('attemptsChartInstance')
      }
    }
  });
}

/**
 * Renders horizontal stacked bar chart for Solved Tags
 */
function renderTagsAcChart(tagsAc) {
  const canvas = document.getElementById('tagsAcChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const ctx = canvas.getContext('2d');
  
  const labels = tagsAc.map(item => item[0]);
  const contestData = tagsAc.map(item => item[1].Contest);
  const virtualData = tagsAc.map(item => item[1].Virtual);
  const practiceData = tagsAc.map(item => item[1].Practice);

  tagsAcChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Contest', data: contestData, backgroundColor: '#8b5cf6', stack: 'tags' },
        { label: 'Virtual', data: virtualData, backgroundColor: '#fb923c', stack: 'tags' },
        { label: 'Practice', data: practiceData, backgroundColor: '#10b981', stack: 'tags' }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          title: { display: true, text: 'Solves Count', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' }
        },
        y: {
          stacked: true,
          grid: { display: false }
        }
      },
      plugins: {
        legend: { display: true, position: 'top' },
        zoom: getZoomOptions('tagsAcChartInstance')
      }
    }
  });
}

/**
 * Renders horizontal stacked percentage bar chart for Tag Verdicts
 */
function renderTagsErrorChart(tagsError) {
  const canvas = document.getElementById('tagsErrorChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const ctx = canvas.getContext('2d');
  
  const labels = tagsError.map(item => item[0]);
  const acData = [];
  const waData = [];
  const tleData = [];
  const mleData = [];
  const otherData = [];
  
  tagsError.forEach(item => {
    const total = item[1].total || 1;
    acData.push(((item[1].AC || 0) / total) * 100);
    waData.push(((item[1].WA || 0) / total) * 100);
    tleData.push(((item[1].TLE || 0) / total) * 100);
    mleData.push(((item[1].MLE || 0) / total) * 100);
    otherData.push(((item[1].Other || 0) / total) * 100);
  });

  tagsErrorChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'AC', data: acData, backgroundColor: '#10b981', stack: 'verdict' },
        { label: 'WA', data: waData, backgroundColor: '#d32f2f', stack: 'verdict' },
        { label: 'TLE', data: tleData, backgroundColor: '#f59e0b', stack: 'verdict' },
        { label: 'MLE', data: mleData, backgroundColor: '#a78bfa', stack: 'verdict' },
        { label: 'Other', data: otherData, backgroundColor: '#64748b', stack: 'verdict' }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          max: 100,
          title: { display: true, text: 'Percentage (%)', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' },
          ticks: {
            callback: (val) => `${val}%`
          }
        },
        y: {
          stacked: true,
          grid: { display: false }
        }
      },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          callbacks: {
            label: (item) => {
              const tagData = tagsError[item.dataIndex][1];
              const val = item.raw.toFixed(1);
              let count = 0;
              if (item.dataset.label === 'AC') count = tagData.AC;
              else if (item.dataset.label === 'WA') count = tagData.WA;
              else if (item.dataset.label === 'TLE') count = tagData.TLE;
              else if (item.dataset.label === 'MLE') count = tagData.MLE;
              else if (item.dataset.label === 'Other') count = tagData.Other;
              return `${item.dataset.label}: ${val}% (${count} / ${tagData.total} attempts)`;
            }
          }
        },
        zoom: getZoomOptions('tagsErrorChartInstance')
      }
    }
  });
}

/**
 * Renders line chart showing average solve time vs problem difficulty
 */
function renderAvgTimeChart(avgSolveTime) {
  const canvas = document.getElementById('avgTimeChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const placeholder = document.getElementById('avg-time-placeholder');

  if (!avgSolveTime || avgSolveTime.length === 0) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    return;
  }

  canvas.classList.remove('hidden');
  placeholder.classList.add('hidden');

  const labels = avgSolveTime.map(item => item[0]);
  const data = avgSolveTime.map(item => item[1] / 60); // Convert to minutes

  const ctx = canvas.getContext('2d');
  avgTimeChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Average Solve Time (mins)',
        data: data,
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.1)',
        borderWidth: 2,
        pointRadius: 4,
        pointBackgroundColor: '#06b6d4',
        fill: true,
        tension: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Problem Rating', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' }
        },
        y: {
          title: { display: true, text: 'Time (minutes)', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const original = avgSolveTime[item.dataIndex];
              return `Avg Time: ${item.raw.toFixed(1)} mins (across ${original[2]} solves)`;
            }
          }
        },
        zoom: getZoomOptions('avgTimeChartInstance')
      }
    }
  });
}

/**
 * Renders radar chart showing accepted solves distribution by 2-hour blocks
 */
function renderActivityTimeChart(activityTime) {
  const canvas = document.getElementById('activityTimeChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) existingChart.destroy();
  const ctx = canvas.getContext('2d');

  // Group 24 hours into 12 two-hour blocks
  const blockLabels = [
    '12–2 AM', '2–4 AM', '4–6 AM', '6–8 AM', '8–10 AM', '10–12 AM',
    '12–2 PM', '2–4 PM', '4–6 PM', '6–8 PM', '8–10 PM', '10–12 PM'
  ];
  
  const localOffsetHours = -new Date().getTimezoneOffset() / 60; // Offset in hours (e.g. +8 for UTC+8)
  const blockData = new Array(12).fill(0);
  activityTime.forEach(item => {
    const utcHour = item[0];
    const count = item[1];
    // Shift from UTC to user's local timezone
    const localHour = (utcHour + localOffsetHours + 24) % 24;
    // Round to nearest integer to handle fractional offsets (like UTC+5.5) cleanly
    const roundedHour = Math.round(localHour) % 24;
    const blockIndex = Math.floor(roundedHour / 2);
    blockData[blockIndex] += count;
  });

  activityTimeChartInstance = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: blockLabels,
      datasets: [{
        label: 'Accepted Solves',
        data: blockData,
        backgroundColor: 'rgba(41, 128, 185, 0.2)',
        borderColor: '#2980b9',
        borderWidth: 2,
        pointBackgroundColor: '#2980b9',
        pointBorderColor: '#fff',
        pointBorderWidth: 1,
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          beginAtZero: true,
          grid: {
            color: 'rgba(0, 0, 0, 0.08)'
          },
          angleLines: {
            color: 'rgba(0, 0, 0, 0.08)'
          },
          pointLabels: {
            font: {
              size: 11,
              family: "'Open Sans', sans-serif"
            },
            color: '#607d8b'
          },
          ticks: {
            display: true,
            backdropColor: 'transparent',
            color: '#90a4ae',
            font: { size: 9 }
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => `Solves: ${item.raw}`
          }
        }
      }
    }
  });
}

/**
 * Renders bubble chart representing accuracy rate vs difficulty gap per tag
 */
function renderTagWeaknessChart(tagWeakness) {
  const canvas = document.getElementById('tagWeaknessChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const placeholder = document.getElementById('tag-weakness-placeholder');

  if (!tagWeakness || tagWeakness.length === 0) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    return;
  }

  canvas.classList.remove('hidden');
  placeholder.classList.add('hidden');

  const maxAttempts = Math.max(...tagWeakness.map(t => t.total), 1);
  const data = tagWeakness.map(item => {
    const radius = 6 + (item.total / maxAttempts) * 18;
    return {
      x: item.avg_gap,
      y: item.ac_rate,
      r: radius,
      tag: item.tag,
      total: item.total,
      ac: item.ac
    };
  });

  const backgroundColors = data.map(d => {
    if (d.x > 0 && d.y < 50) return 'rgba(211, 47, 47, 0.65)';  // Red
    if (d.x > 0 && d.y >= 50) return 'rgba(59, 130, 246, 0.65)'; // Blue
    if (d.x <= 0 && d.y < 50) return 'rgba(245, 158, 11, 0.65)'; // Orange
    return 'rgba(16, 185, 129, 0.65)';                          // Green
  });

  const borderColors = data.map(d => {
    if (d.x > 0 && d.y < 50) return '#d32f2f';
    if (d.x > 0 && d.y >= 50) return '#3b82f6';
    if (d.x <= 0 && d.y < 50) return '#f59e0b';
    return '#10b981';
  });

  const ctx = canvas.getContext('2d');
  tagWeaknessChartInstance = new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: [{
        label: 'Tags',
        data: data,
        backgroundColor: backgroundColors,
        borderColor: borderColors,
        borderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: {
            display: true,
            text: 'Average Difficulty Gap (Problem Rating - User Rating)',
            color: '#607d8b'
          },
          grid: {
            color: (context) => context.tick.value === 0 ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.06)',
            lineWidth: (context) => context.tick.value === 0 ? 1.5 : 1
          }
        },
        y: {
          min: 0,
          max: 100,
          title: {
            display: true,
            text: 'Accuracy / AC Rate (%)',
            color: '#607d8b'
          },
          grid: {
            color: (context) => context.tick.value === 50 ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.06)',
            lineWidth: (context) => context.tick.value === 50 ? 1.5 : 1
          },
          ticks: {
            callback: (val) => `${val}%`
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const raw = item.raw;
              const gapSign = raw.x >= 0 ? '+' : '';
              return [
                `Tag: ${raw.tag}`,
                `AC Rate: ${raw.y.toFixed(1)}% (${raw.ac} / ${raw.total} attempts)`,
                `Avg Difficulty Gap: ${gapSign}${raw.x.toFixed(0)} rating points`
              ];
            }
          }
        },
        zoom: getZoomOptions('tagWeaknessChartInstance')
      }
    }
  });
}

/**
 * Renders line chart representing cumulative upsolved problems over time (practice solves of contest problems)
 * and displays a focused pending checklist.
 */
function renderUpsolveTrackerChart(upsolveData) {
  const canvas = document.getElementById('upsolveTrackerChart');
  if (!canvas) return;
  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }
  const placeholder = document.getElementById('upsolve-tracker-placeholder');
  const statsSummary = document.getElementById('upsolve-stats-summary');
  const checklistSection = document.getElementById('upsolve-checklist-section');

  const hasData = upsolveData && 
                  ((upsolveData.upsolveHistory && upsolveData.upsolveHistory.length > 0) || 
                   (upsolveData.pendingChecklist && upsolveData.pendingChecklist.length > 0));

  if (!hasData) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    if (statsSummary) statsSummary.classList.add('hidden');
    if (checklistSection) checklistSection.classList.add('hidden');
    return;
  }

  canvas.classList.remove('hidden');
  placeholder.classList.add('hidden');
  if (statsSummary) statsSummary.classList.remove('hidden');
  if (checklistSection) checklistSection.classList.remove('hidden');

  const { upsolveHistory = [], pendingChecklist = [] } = upsolveData;

  // 1. Calculate Aggregate Stats
  const totalUpsolved = upsolveHistory.length;
  const pendingContests = pendingChecklist.length;
  const totalEncountered = totalUpsolved + pendingContests;
  const upsolveRate = totalEncountered > 0 ? ((totalUpsolved / totalEncountered) * 100).toFixed(1) : '0.0';

  // Fill in stat values
  const solvedValEl = document.getElementById('upsolve-stat-solved');
  const pendingValEl = document.getElementById('upsolve-stat-pending');
  const rateValEl = document.getElementById('upsolve-stat-rate');

  if (solvedValEl) solvedValEl.textContent = totalUpsolved;
  if (pendingValEl) pendingValEl.textContent = pendingContests;
  if (rateValEl) rateValEl.textContent = `${upsolveRate}%`;

  // 2. Prepare Data Series for Cumulative Upsolve Chart
  const upsolvedSeries = [];
  let cumulativeCount = 0;

  // Establish a start date of 0 upsolves just before the first contest or solve
  let firstTime = Date.now();
  if (upsolveHistory.length > 0) {
    firstTime = Math.min(firstTime, upsolveHistory[0].time * 1000, upsolveHistory[0].solveTime * 1000);
  }
  if (pendingChecklist.length > 0) {
    firstTime = Math.min(firstTime, pendingChecklist[pendingChecklist.length - 1].time * 1000);
  }
  upsolvedSeries.push({ x: firstTime - 60000, y: 0 });

  // Map each solve chronologically
  upsolveHistory.forEach(item => {
    cumulativeCount++;
    upsolvedSeries.push({
      x: item.solveTime * 1000,
      y: cumulativeCount,
      contestId: item.contestId,
      problemIndex: item.problemIndex,
      name: item.name,
      rating: item.rating
    });
  });

  // Extend line flat to today (now)
  upsolvedSeries.push({ x: Date.now(), y: cumulativeCount });

  // 3. Initialize Chart
  const ctx = canvas.getContext('2d');
  upsolveTrackerChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Cumulative Upsolved Problems',
          data: upsolvedSeries,
          borderColor: '#2e7d32',
          backgroundColor: 'rgba(46, 125, 50, 0.05)',
          borderWidth: 3,
          pointRadius: 4,
          pointBackgroundColor: '#2e7d32',
          fill: true,
          tension: 0,
          stepped: true // Renders stepped line representing discrete solve events
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (val) => {
              if (val > 0) {
                return new Date(val).toLocaleDateString();
              }
              return '';
            },
            maxTicksLimit: 8
          },
          grid: { color: 'rgba(0, 0, 0, 0.06)' },
          title: { display: true, text: 'Solve Date', color: '#607d8b' }
        },
        y: {
          title: { display: true, text: 'Total Upsolved Problems', color: '#607d8b' },
          grid: { color: 'rgba(0, 0, 0, 0.06)' },
          ticks: { precision: 0 }
        }
      },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].raw.x).toLocaleDateString(),
            label: (item) => {
              const raw = item.raw;
              if (raw.contestId) {
                return [
                  `Upsolved: ${raw.problemIndex} - ${raw.name}`,
                  `Contest: ${raw.contestId}`,
                  `Difficulty Rating: ${raw.rating || 'Unrated'}`,
                  `Total Upsolved Count: ${raw.y}`
                ];
              } else {
                return `Total Upsolved Count: ${raw.y}`;
              }
            }
          }
        },
        zoom: getZoomOptions('upsolveTrackerChartInstance')
      }
    }
  });

  // 4. Render Dynamic Checklist Table
  function populateChecklist(showCompleted) {
    const tbody = document.getElementById('upsolve-checklist-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Union the lists for display (pending + solved)
    const combinedList = [];

    pendingChecklist.forEach(p => {
      combinedList.push({
        contestId: p.contestId,
        problemIndex: p.problemIndex,
        name: p.name,
        rating: p.rating,
        time: p.time,
        upsolved: false
      });
    });

    upsolveHistory.forEach(u => {
      combinedList.push({
        contestId: u.contestId,
        problemIndex: u.problemIndex,
        name: u.name,
        rating: u.rating,
        time: u.time || u.solveTime, // fallback to solveTime if contest time is not present
        upsolved: true,
        solveTime: u.solveTime
      });
    });

    // Sort by contest date descending (latest contests first)
    combinedList.sort((a, b) => b.time - a.time);

    let rowsAdded = 0;
    combinedList.forEach(item => {
      if (!showCompleted && item.upsolved) return;

      const tr = document.createElement('tr');

      // Status cell
      const tdStatus = document.createElement('td');
      tdStatus.className = 'col-checkbox';
      if (item.upsolved) {
        const dateStr = new Date(item.solveTime * 1000).toLocaleDateString();
        tdStatus.innerHTML = `<i class="fa-solid fa-circle-check upsolve-status-checkbox status-solved" title="Upsolved on ${dateStr}"></i>`;
      } else {
        tdStatus.innerHTML = `<i class="fa-solid fa-circle-xmark upsolve-status-checkbox status-pending" title="Pending upsolve"></i>`;
      }
      tr.appendChild(tdStatus);

      // Contest cell
      const tdContest = document.createElement('td');
      tdContest.className = 'col-contest';
      tdContest.textContent = item.contestId;
      tr.appendChild(tdContest);

      // Problem Name cell
      const tdName = document.createElement('td');
      tdName.textContent = `${item.problemIndex} - ${item.name}`;
      tr.appendChild(tdName);

      // Difficulty Rating cell
      const tdRating = document.createElement('td');
      tdRating.className = 'col-rating';
      if (item.rating) {
        const color = getColorForRating(item.rating);
        tdRating.innerHTML = `<span class="badge-rating" style="background-color: ${color}">${item.rating}</span>`;
      } else {
        tdRating.innerHTML = `<span class="badge-rating" style="background-color: #78909c">Unrated</span>`;
      }
      tr.appendChild(tdRating);

      // Solve link cell
      const tdAction = document.createElement('td');
      tdAction.className = 'col-action';
      const solveLink = `https://codeforces.com/contest/${item.contestId}/problem/${item.problemIndex}`;
      tdAction.innerHTML = `<a href="${solveLink}" target="_blank" class="btn-upsolve-link"><i class="fa-solid fa-arrow-up-right-from-square"></i> Solve</a>`;
      tr.appendChild(tdAction);

      tbody.appendChild(tr);
      rowsAdded++;
    });

    if (rowsAdded === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="5" style="text-align: center; color: var(--text-muted); padding: 25px;">No contest problems matching the filter.</td>`;
      tbody.appendChild(tr);
    }
  }

  // Set up filter checkbox event listener
  const showCompletedCheckbox = document.getElementById('upsolve-show-completed');
  if (showCompletedCheckbox) {
    const newCheckbox = showCompletedCheckbox.cloneNode(true);
    showCompletedCheckbox.parentNode.replaceChild(newCheckbox, showCompletedCheckbox);
    
    // Set initial display
    populateChecklist(newCheckbox.checked);

    newCheckbox.addEventListener('change', (e) => {
      populateChecklist(e.target.checked);
    });
  } else {
    populateChecklist(true);
  }
}

// Add horizontal scroll listener to navigation bar for desktop mouse wheel support
const chartsNav = document.querySelector('.charts-nav');
if (chartsNav) {
  chartsNav.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0) {
      e.preventDefault();
      chartsNav.scrollLeft += e.deltaY;
    }
  });
}

// Inject zoom instructions into card headers on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.card-header-actions').forEach(actions => {
    const card = actions.closest('.chart-card');
    // Only inject hint if the card contains a canvas (which means it's a zoomable chart)
    if (card && card.querySelector('canvas')) {
      const hint = document.createElement('span');
      hint.className = 'zoom-hint';
      hint.innerHTML = '<i class="fa-solid fa-keyboard"></i> Ctrl + Scroll to Zoom';
      // Insert it before the reset button or tooltip
      actions.insertBefore(hint, actions.firstChild);
    }
  });
});

