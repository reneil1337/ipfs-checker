<script setup>
import { ref, reactive } from 'vue'
import TokenTable from './components/TokenTable.vue'

const contractAddress = ref('')
const isAnalyzing = ref(false)
const progress = reactive({
  current: 0,
  total: 0,
  percentage: 0
})
const stats = reactive({
  found: 0,
  skipped: 0
})
const statusMessage = ref('')
const results = ref([])
const contractInfo = ref(null)
const error = ref(null)
const eventSource = ref(null)

function extractAddress(input) {
  const addressMatch = input.match(/0x[a-fA-F0-9]{40}/)
  return addressMatch ? addressMatch[0] : input.trim()
}

async function startAnalysis() {
  const address = extractAddress(contractAddress.value)
  
  if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) {
    error.value = 'Please enter a valid Ethereum contract address'
    return
  }
  
  // Reset state
  results.value = []
  error.value = null
  isAnalyzing.value = true
  statusMessage.value = ''
  progress.current = 0
  progress.total = 0
  progress.percentage = 0
  stats.found = 0
  stats.skipped = 0
  
  if (eventSource.value) {
    eventSource.value.close()
  }
  
  const baseUrl = import.meta.env.VITE_API_URL || ''
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
        contractInfo.value = data.contract
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
        statusMessage.value = `Done! ${stats.found} tokens found, ${stats.skipped} empty IDs skipped.`
        eventSource.value.close()
        break
        
      case 'error':
        error.value = data.error
        isAnalyzing.value = false
        eventSource.value.close()
        break
    }
  }
  
  eventSource.value.onerror = (err) => {
    console.error('SSE error:', err)
    // Only show error if we haven't received any data yet
    if (results.value.length === 0 && !contractInfo.value) {
      error.value = 'Connection error. Is the backend running?'
    }
    isAnalyzing.value = false
    eventSource.value.close()
  }
}

function stopAnalysis() {
  if (eventSource.value) {
    eventSource.value.close()
    eventSource.value = null
  }
  isAnalyzing.value = false
  statusMessage.value = `Stopped. ${stats.found} tokens found so far.`
}
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
            :disabled="isAnalyzing || !contractAddress"
            class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span v-if="isAnalyzing">
              <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Analyzing...
            </span>
            <span v-else>Analyze Contract</span>
          </button>
          <button
            v-if="isAnalyzing"
            @click="stopAnalysis"
            class="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            Stop
          </button>
        </div>
        
        <!-- Progress Bar -->
        <div v-if="isAnalyzing && progress.total > 0" class="mt-4">
          <div class="flex justify-between text-sm text-gray-600 mb-1">
            <span>{{ statusMessage }}</span>
            <span>{{ progress.current }} / {{ progress.total }} ({{ progress.percentage }}%)</span>
          </div>
          <div class="w-full bg-gray-200 rounded-full h-2">
            <div
              class="bg-indigo-600 h-2 rounded-full transition-all duration-300"
              :style="{ width: progress.percentage + '%' }"
            ></div>
          </div>
        </div>

        <!-- Status message when not analyzing -->
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

      <!-- Contract Info -->
      <div v-if="contractInfo" class="bg-white rounded-lg shadow p-4 mb-6">
        <div class="flex items-center gap-4">
          <div>
            <h2 class="text-lg font-medium text-gray-900">{{ contractInfo.name || 'Unknown' }}</h2>
            <p class="text-sm text-gray-500">{{ contractInfo.symbol || 'Unknown' }}</p>
          </div>
          <div class="flex-1"></div>
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
      />
      
      <!-- Empty State -->
      <div v-else-if="!isAnalyzing && !statusMessage" class="text-center py-12">
        <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        <h3 class="mt-2 text-sm font-medium text-gray-900">No tokens analyzed yet</h3>
        <p class="mt-1 text-sm text-gray-500">Enter a contract address above to start analyzing.</p>
      </div>
    </main>
  </div>
</template>
