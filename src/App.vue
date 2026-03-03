<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import TokenTable from './components/TokenTable.vue'

const contractAddress = ref('')
const isAnalyzing = ref(false)
const isRechecking = ref(false)
const progress = reactive({
  current: 0,
  total: 0,
  percentage: 0,
  updated: 0,       // recheck: how many items changed
  mode: null         // 'analyze' | 'recheck' | null
})
const stats = reactive({
  found: 0,
  skipped: 0
})
const statusMessage = ref('')
const results = ref([])
const contractInfo = ref(null)
const analysisStatus = ref(null) // 'complete', 'paused', 'in_progress', null
const error = ref(null)
const eventSource = ref(null)
const previousContracts = ref([])

const baseUrl = import.meta.env.VITE_API_URL || ''

function extractAddress(input) {
  const addressMatch = input.match(/0x[a-fA-F0-9]{40}/)
  return addressMatch ? addressMatch[0] : input.trim()
}

// Load list of previously analyzed contracts
async function loadPreviousContracts() {
  try {
    const resp = await fetch(`${baseUrl}/api/contracts`)
    if (resp.ok) {
      previousContracts.value = await resp.json()
    }
  } catch { /* ignore */ }
}

// Load cached results for a contract without starting analysis
async function loadCachedResults(address) {
  const normalized = address.toLowerCase()
  try {
    const resp = await fetch(`${baseUrl}/api/results/${normalized}`)
    if (resp.ok) {
      const data = await resp.json()
      if (data.analysis) {
        contractInfo.value = {
          address: normalized,
          name: data.analysis.name,
          symbol: data.analysis.symbol,
          contractURI: data.analysis.contract_uri || null,
          contractURIHash: data.analysis.contract_uri_hash || null,
          contractURIStatus: data.analysis.contract_uri_status || null
        }
        analysisStatus.value = data.analysis.status
        stats.found = data.analysis.tokens_found
        stats.skipped = data.analysis.tokens_skipped
        progress.total = data.analysis.end_id - data.analysis.start_id + 1
        progress.current = data.analysis.last_scanned_id - data.analysis.start_id + 1
        progress.percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

        if (data.analysis.status === 'complete') {
          statusMessage.value = `Analysis complete. ${stats.found} tokens found, ${stats.skipped} empty IDs skipped.`
        } else if (data.analysis.status === 'paused') {
          statusMessage.value = `Analysis paused at #${data.analysis.last_scanned_id}. ${stats.found} tokens found. Hit Continue to resume.`
        }
      }
      if (data.tokens && data.tokens.length > 0) {
        results.value = data.tokens
      }
      return true
    }
  } catch { /* ignore */ }
  return false
}

// Start or continue analysis via SSE
async function startAnalysis() {
  const address = extractAddress(contractAddress.value)
  
  if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) {
    error.value = 'Please enter a valid Ethereum contract address'
    return
  }
  
  error.value = null
  isAnalyzing.value = true
  
  // Don't reset results -- the backend sends cached tokens first when resuming
  if (analysisStatus.value !== 'paused' && analysisStatus.value !== 'in_progress') {
    results.value = []
    stats.found = 0
    stats.skipped = 0
    progress.current = 0
    progress.total = 0
    progress.percentage = 0
    progress.updated = 0
    progress.mode = null
    contractInfo.value = null
    analysisStatus.value = null
  }
  progress.mode = 'analyze'

  statusMessage.value = 'Connecting...'
  
  if (eventSource.value) {
    eventSource.value.close()
  }
  
  eventSource.value = new EventSource(`${baseUrl}/api/analyze/${address}?maxTokens=10000&delay=300`)
  
  eventSource.value.onmessage = (event) => {
    const data = JSON.parse(event.data)
    
    switch (data.type) {
      case 'connected':
        statusMessage.value = 'Connected, starting analysis...'
        break
        
      case 'info':
        statusMessage.value = data.message
        break
        
      case 'start':
        progress.total = data.total
        contractInfo.value = {
          ...data.contract,
          contractURI: data.contract.contractURI || null,
          contractURIHash: data.contract.contractURIHash || null,
          contractURIStatus: data.contract.contractURIStatus || null
        }
        analysisStatus.value = 'in_progress'
        statusMessage.value = `Scanning ${data.total} token IDs...`
        break
        
      case 'token': {
        const existingIndex = results.value.findIndex(r => r.tokenId === data.token.tokenId)
        if (existingIndex >= 0) {
          results.value[existingIndex] = data.token
        } else {
          results.value.push(data.token)
        }
        results.value.sort((a, b) => a.tokenId - b.tokenId)
        
        stats.found = results.value.length
        progress.current = data.progress.current
        progress.percentage = data.progress.percentage
        statusMessage.value = `Found ${stats.found} tokens, skipped ${stats.skipped} empty IDs...`
        break
      }
      
      case 'skip':
        stats.skipped++
        progress.current = data.progress.current
        progress.percentage = data.progress.percentage
        statusMessage.value = `Found ${stats.found} tokens, skipped ${stats.skipped} empty IDs...`
        break
        
      case 'complete':
        isAnalyzing.value = false
        analysisStatus.value = 'complete'
        progress.mode = null
        statusMessage.value = `Done! ${stats.found} tokens found, ${stats.skipped} empty IDs skipped.`
        eventSource.value.close()
        loadPreviousContracts()
        break
        
      case 'error':
        error.value = data.error
        isAnalyzing.value = false
        progress.mode = null
        eventSource.value.close()
        break
    }
  }
  
  eventSource.value.onerror = (err) => {
    console.error('SSE error:', err)
    if (results.value.length === 0 && !contractInfo.value) {
      error.value = 'Connection error. Is the backend running?'
    } else {
      analysisStatus.value = 'paused'
      statusMessage.value = `Connection lost. ${stats.found} tokens saved. Hit Continue to resume.`
    }
    isAnalyzing.value = false
    progress.mode = null
    eventSource.value.close()
  }
}

function stopAnalysis() {
  if (eventSource.value) {
    eventSource.value.close()
    eventSource.value = null
  }
  isAnalyzing.value = false
  analysisStatus.value = 'paused'
  progress.mode = null
  statusMessage.value = `Paused. ${stats.found} tokens saved. Hit Continue to resume.`
}

function selectContract(address) {
  contractAddress.value = address
  loadCachedResults(address)
}

// Determine button label
function getButtonLabel() {
  if (isAnalyzing.value) return null // spinner shown instead
  if (analysisStatus.value === 'paused' || analysisStatus.value === 'in_progress') return 'Continue Analysis'
  if (analysisStatus.value === 'complete') return 'Re-analyze'
  return 'Analyze Contract'
}

// Count tokens that have offline or unknown statuses (candidates for recheck)
const recheckCount = computed(() => {
  let count = results.value.filter(t =>
    t.metadataStatus === 'offline' || t.metadataStatus === 'unknown' ||
    t.imageStatus === 'offline' || t.imageStatus === 'unknown' ||
    t.animationStatus === 'offline' || t.animationStatus === 'unknown'
  ).length
  // Include contractURI if it's offline/unknown
  const cStatus = contractInfo.value?.contractURIStatus
  if (cStatus === 'offline' || cStatus === 'unknown') count++
  return count
})

// Recheck offline/unknown hashes via SSE
function startRecheck() {
  const address = extractAddress(contractAddress.value)
  if (!address) return

  error.value = null
  isRechecking.value = true
  progress.current = 0
  progress.total = 0
  progress.percentage = 0
  progress.updated = 0
  progress.mode = 'recheck'
  statusMessage.value = 'Starting recheck of offline/unknown hashes...'

  if (eventSource.value) {
    eventSource.value.close()
  }

  eventSource.value = new EventSource(`${baseUrl}/api/recheck/${address}`)

  eventSource.value.onmessage = (event) => {
    const data = JSON.parse(event.data)

    switch (data.type) {
      case 'info':
        statusMessage.value = data.message
        break

      case 'recheck_contract_uri':
        if (contractInfo.value) {
          contractInfo.value.contractURIStatus = data.status
        }
        if (data.changed) progress.updated++
        statusMessage.value = `Rechecked contractURI: ${data.status}`
        break

      case 'recheck': {
        // Update the token in results with new statuses
        const idx = results.value.findIndex(r => r.tokenId === data.token.tokenId)
        if (idx >= 0) {
          results.value[idx] = { ...results.value[idx], ...data.token }
        }
        progress.current = data.progress.current
        progress.total = data.progress.total
        progress.percentage = data.progress.percentage
        if (data.changed) progress.updated++
        statusMessage.value = `Rechecking: ${data.progress.current}/${data.progress.total} — ${progress.updated} updated`
        break
      }

      case 'complete':
        isRechecking.value = false
        progress.mode = null
        statusMessage.value = `Recheck complete. ${data.updated} token(s) updated.`
        eventSource.value.close()
        break

      case 'error':
        error.value = data.error
        isRechecking.value = false
        eventSource.value.close()
        break
    }
  }

  eventSource.value.onerror = () => {
    // Ignore if we already finished (complete event already processed)
    if (!isRechecking.value) return
    isRechecking.value = false
    statusMessage.value = 'Recheck connection lost.'
    eventSource.value.close()
  }
}

function stopRecheck() {
  if (eventSource.value) {
    eventSource.value.close()
    eventSource.value = null
  }
  isRechecking.value = false
  progress.mode = null
  statusMessage.value = `Recheck stopped. ${progress.updated} token(s) updated so far.`
}

onMounted(() => {
  loadPreviousContracts()
})
</script>

<template>
  <div class="min-h-screen bg-gray-50">
    <!-- Header -->
    <header class="bg-white shadow-sm border-b border-gray-200">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-bold text-gray-900">IPFS NFT Checker</h1>
            <p class="text-sm text-gray-500 mt-1">
              Analyze Ethereum smart contracts and check IPFS hash availability in real-time
            </p>
          </div>
          <div class="flex gap-2">
            <span v-if="stats.found > 0" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
              {{ stats.found }} tokens
            </span>
            <span v-if="stats.skipped > 0" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
              {{ stats.skipped }} skipped
            </span>
            <span v-if="analysisStatus === 'paused'" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
              Paused
            </span>
            <span v-else-if="analysisStatus === 'complete'" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
              Complete
            </span>
          </div>
        </div>
      </div>
    </header>

    <!-- Main Content -->
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Input Section -->
      <div class="bg-white rounded-lg shadow p-6 mb-8">
        <label for="contract" class="block text-sm font-medium text-gray-700 mb-2">
          Contract Address or Etherscan URL
        </label>
        <div class="flex gap-3">
          <input
            id="contract"
            v-model="contractAddress"
            type="text"
            placeholder="0x87d04ff86cafee75d572691b31509f72c0088c2b"
            class="flex-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-4 py-2 border"
            @keyup.enter="startAnalysis"
            :disabled="isAnalyzing"
          />
          <button
            @click="startAnalysis"
            :disabled="isAnalyzing || isRechecking || !contractAddress"
            class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span v-if="isAnalyzing || isRechecking">
              <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ isRechecking ? 'Rechecking...' : 'Analyzing...' }}
            </span>
            <span v-else>{{ getButtonLabel() }}</span>
          </button>
          <button
            v-if="isAnalyzing"
            @click="stopAnalysis"
            class="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            Stop
          </button>
          <button
            v-if="isRechecking"
            @click="stopRecheck"
            class="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            Stop
          </button>
        </div>
        
        <!-- Unified Progress Bar -->
        <div v-if="progress.total > 0" class="mt-4">
          <div class="flex justify-between text-sm text-gray-600 mb-1">
            <span>{{ statusMessage }}</span>
            <span>{{ progress.current }} / {{ progress.total }} ({{ progress.percentage }}%)</span>
          </div>
          <div class="w-full bg-gray-200 rounded-full h-2">
            <div
              class="h-2 rounded-full transition-all duration-300"
              :class="{
                'bg-green-500': !progress.mode && analysisStatus === 'complete',
                'bg-yellow-500': !progress.mode && analysisStatus === 'paused',
                'bg-orange-500': progress.mode === 'recheck',
                'bg-indigo-600': progress.mode === 'analyze'
              }"
              :style="{ width: progress.percentage + '%' }"
            ></div>
          </div>
        </div>

        <!-- Status message when no progress bar -->
        <div v-else-if="statusMessage" class="mt-4 text-sm text-gray-600">
          {{ statusMessage }}
        </div>
        
        <!-- Error Message -->
        <div v-if="error" class="mt-4 p-4 bg-red-50 border-l-4 border-red-400">
          <div class="flex">
            <div class="flex-shrink-0">
              <svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
              </svg>
            </div>
            <div class="ml-3">
              <p class="text-sm text-red-700">{{ error }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Previous Contracts -->
      <div v-if="previousContracts.length > 0 && !contractInfo" class="bg-white rounded-lg shadow mb-8 overflow-hidden">
        <div class="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <h3 class="text-sm font-medium text-gray-700">Previous Analyses</h3>
        </div>
        <div class="divide-y divide-gray-200">
          <button
            v-for="c in previousContracts"
            :key="c.contract_address"
            @click="selectContract(c.contract_address)"
            class="w-full px-6 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors text-left"
          >
            <div>
              <span class="text-sm font-medium text-gray-900">{{ c.name || 'Unknown' }}</span>
              <span class="text-xs text-gray-500 ml-2">{{ c.symbol || '' }}</span>
              <p class="text-xs text-gray-400 font-mono">{{ c.contract_address }}</p>
            </div>
            <div class="flex gap-2 items-center">
              <span class="text-xs text-gray-500">{{ c.tokens_found }} tokens</span>
              <span
                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                :class="c.status === 'complete' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'"
              >
                {{ c.status }}
              </span>
            </div>
          </button>
        </div>
      </div>

      <!-- Contract Info -->
      <div v-if="contractInfo" class="bg-white rounded-lg shadow p-4 mb-6">
        <div class="flex items-center gap-4">
          <div>
            <h2 class="text-lg font-medium text-gray-900">{{ contractInfo.name || 'Unknown' }}</h2>
            <p class="text-sm text-gray-500">{{ contractInfo.symbol || 'Unknown' }}</p>
          </div>
          <!-- Contract URI status -->
          <div v-if="contractInfo.contractURIHash" class="flex items-center gap-2">
            <span class="text-xs text-gray-500">contractURI:</span>
            <span
              class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border"
              :class="{
                'bg-green-100 text-green-800 border-green-200': contractInfo.contractURIStatus === 'online',
                'bg-red-100 text-red-800 border-red-200': contractInfo.contractURIStatus === 'offline',
                'bg-yellow-100 text-yellow-800 border-yellow-200': contractInfo.contractURIStatus === 'unknown',
                'bg-gray-50 text-gray-500 border-gray-200': contractInfo.contractURIStatus === 'non-ipfs'
              }"
            >
              {{ contractInfo.contractURIStatus }}
            </span>
            <a
              :href="`https://ipfs.io/ipfs/${contractInfo.contractURIHash}`"
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs text-indigo-600 hover:text-indigo-800 hover:underline font-mono"
              :title="contractInfo.contractURIHash"
            >
              {{ contractInfo.contractURIHash.length > 20 ? contractInfo.contractURIHash.slice(0, 8) + '...' + contractInfo.contractURIHash.slice(-8) : contractInfo.contractURIHash }}
            </a>
          </div>
          <div v-else-if="contractInfo.contractURI" class="flex items-center gap-2">
            <span class="text-xs text-gray-500">contractURI:</span>
            <span class="text-xs text-gray-400">non-IPFS</span>
          </div>
          <div class="flex-1"></div>
          <button
            v-if="recheckCount > 0 && !isAnalyzing && !isRechecking"
            @click="startRecheck"
            class="inline-flex items-center px-3 py-1.5 border border-orange-300 text-sm font-medium rounded-md text-orange-700 bg-orange-50 hover:bg-orange-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 transition-colors"
          >
            Recheck {{ recheckCount }} offline/unknown
          </button>
          <button
            v-if="isRechecking"
            @click="stopRecheck"
            class="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500"
          >
            Stop recheck
          </button>
          <a
            :href="`https://etherscan.io/address/${contractInfo.address}`"
            target="_blank"
            rel="noopener noreferrer"
            class="text-indigo-600 hover:text-indigo-800 text-sm"
          >
            View on Etherscan &rarr;
          </a>
        </div>
      </div>

      <!-- Results Table -->
      <TokenTable
        v-if="results.length > 0"
        :tokens="results"
        :contract-info="contractInfo"
      />
      
      <!-- Empty State -->
      <div v-else-if="!isAnalyzing && !statusMessage && previousContracts.length === 0" class="text-center py-12">
        <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        <h3 class="mt-2 text-sm font-medium text-gray-900">No tokens analyzed yet</h3>
        <p class="mt-1 text-sm text-gray-500">Enter a contract address above to start analyzing.</p>
      </div>
    </main>
  </div>
</template>
