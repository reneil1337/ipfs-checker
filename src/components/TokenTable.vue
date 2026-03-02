<script setup>
import { computed } from 'vue'

const props = defineProps({
  tokens: {
    type: Array,
    required: true
  }
})

const IPFS_GATEWAY = import.meta.env.VITE_IPFS_GATEWAY || 'https://ipfs.io/ipfs/'

const statusOrder = {
  'offline': 0,
  'error': 1,
  'unknown': 2,
  'online': 3,
  'none': 4
}

const sortedTokens = computed(() => {
  return [...props.tokens].sort((a, b) => {
    // Sort by status priority (offline first, then errors, etc.)
    const aPriority = Math.min(
      statusOrder[a.metadataStatus] ?? 2,
      statusOrder[a.imageStatus] ?? 4,
      statusOrder[a.animationStatus] ?? 4
    )
    const bPriority = Math.min(
      statusOrder[b.metadataStatus] ?? 2,
      statusOrder[b.imageStatus] ?? 4,
      statusOrder[b.animationStatus] ?? 4
    )
    
    if (aPriority !== bPriority) {
      return aPriority - bPriority
    }
    
    return a.tokenId - b.tokenId
  })
})

const summary = computed(() => {
  const total = props.tokens.length
  const offline = props.tokens.filter(t => 
    t.metadataStatus === 'offline' || 
    t.imageStatus === 'offline' || 
    t.animationStatus === 'offline'
  ).length
  const errors = props.tokens.filter(t => t.metadataStatus === 'error').length
  
  return { total, offline, errors }
})

function getStatusColor(status) {
  switch (status) {
    case 'online': return 'bg-green-100 text-green-800 border-green-200'
    case 'offline': return 'bg-red-100 text-red-800 border-red-200'
    case 'error': return 'bg-orange-100 text-orange-800 border-orange-200'
    case 'none': return 'bg-gray-50 text-gray-400 border-gray-200'
    default: return 'bg-yellow-100 text-yellow-800 border-yellow-200'
  }
}

function getStatusIcon(status) {
  switch (status) {
    case 'online': return '✓'
    case 'offline': return '✗'
    case 'error': return '!'
    case 'none': return '-'
    default: return '?'
  }
}

function formatHash(hash) {
  if (!hash) return '-'
  if (hash.length <= 20) return hash
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`
}

function getIpfsUrl(hash) {
  if (!hash) return null
  return `${IPFS_GATEWAY}${hash}`
}

function hasIssues(token) {
  return token.metadataStatus === 'offline' || 
         token.metadataStatus === 'error' ||
         token.imageStatus === 'offline' ||
         token.animationStatus === 'offline'
}
</script>

<template>
  <div class="bg-white rounded-lg shadow overflow-hidden">
    <!-- Summary -->
    <div class="px-6 py-4 border-b border-gray-200 bg-gray-50">
      <div class="flex items-center gap-4">
        <div class="text-sm font-medium text-gray-700">
          Summary:
        </div>
        <div class="flex gap-2">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
            Total: {{ summary.total }}
          </span>
          <span v-if="summary.offline > 0" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
            Offline: {{ summary.offline }}
          </span>
          <span v-if="summary.errors > 0" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
            Errors: {{ summary.errors }}
          </span>
        </div>
      </div>
    </div>

    <!-- Table -->
    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Token ID
            </th>
            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Metadata
            </th>
            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Image
            </th>
            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Animation
            </th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr 
            v-for="token in sortedTokens" 
            :key="token.tokenId"
            :class="{ 'bg-red-50': hasIssues(token) }"
            class="hover:bg-gray-50 transition-colors"
          >
            <!-- Token ID -->
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
              #{{ token.tokenId }}
            </td>
            
            <!-- Metadata -->
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="flex flex-col gap-1">
                <span 
                  class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border"
                  :class="getStatusColor(token.metadataStatus)"
                >
                  <span class="mr-1">{{ getStatusIcon(token.metadataStatus) }}</span>
                  {{ token.metadataStatus === 'none' ? 'N/A' : token.metadataStatus }}
                </span>
                <a 
                  v-if="token.metadataHash"
                  :href="getIpfsUrl(token.metadataHash)" 
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-indigo-600 hover:text-indigo-800 hover:underline"
                  :title="token.metadataHash"
                >
                  {{ formatHash(token.metadataHash) }}
                </a>
                <span v-else-if="token.tokenURI" class="text-xs text-gray-500 truncate max-w-[150px]" :title="token.tokenURI">
                  {{ token.tokenURI.startsWith('http') ? 'External URL' : token.tokenURI }}
                </span>
                <span v-else class="text-xs text-gray-400">No URI</span>
              </div>
            </td>
            
            <!-- Image -->
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="flex flex-col gap-1">
                <span 
                  class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border"
                  :class="getStatusColor(token.imageStatus)"
                >
                  <span class="mr-1">{{ getStatusIcon(token.imageStatus) }}</span>
                  {{ token.imageStatus === 'none' ? 'N/A' : token.imageStatus }}
                </span>
                <a 
                  v-if="token.imageHash"
                  :href="getIpfsUrl(token.imageHash)" 
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-indigo-600 hover:text-indigo-800 hover:underline"
                  :title="token.imageHash"
                >
                  {{ formatHash(token.imageHash) }}
                </a>
              </div>
            </td>
            
            <!-- Animation -->
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="flex flex-col gap-1">
                <span 
                  class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border"
                  :class="getStatusColor(token.animationStatus)"
                >
                  <span class="mr-1">{{ getStatusIcon(token.animationStatus) }}</span>
                  {{ token.animationStatus === 'none' ? 'N/A' : token.animationStatus }}
                </span>
                <a 
                  v-if="token.animationHash"
                  :href="getIpfsUrl(token.animationHash)" 
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-indigo-600 hover:text-indigo-800 hover:underline"
                  :title="token.animationHash"
                >
                  {{ formatHash(token.animationHash) }}
                </a>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    
    <!-- Footer with count -->
    <div class="px-6 py-3 bg-gray-50 border-t border-gray-200">
      <p class="text-sm text-gray-500">
        Showing {{ sortedTokens.length }} tokens
        <span v-if="sortedTokens.length !== tokens.length">(sorted by issues first)</span>
      </p>
    </div>
  </div>
</template>
