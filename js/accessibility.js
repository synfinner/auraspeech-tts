// Enhanced accessibility features for AuraSpeech
// This file contains additional accessibility enhancements

// Default speech settings with accessibility focus
const defaultAccessibilitySettings = {
  // Default voice is Nova which is clear and natural
  voice: 'nova',
  // Default speed is 1.0 (normal speed)
  speed: 1.0,
  // Default pitch adjustment (1.0 is normal)
  pitch: 1.0,
  // High-contrast UI elements by default
  highContrast: true,
  // Auto-detect language (for multilingual support)
  autoDetectLanguage: true,
};

// Function to save accessibility settings
function saveAccessibilitySettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ accessibilitySettings: settings }, resolve);
  });
}

// Function to load accessibility settings
function loadAccessibilitySettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('accessibilitySettings', (result) => {
      resolve(result.accessibilitySettings || defaultAccessibilitySettings);
    });
  });
}

// Function to apply accessibility settings to TTS request
function applyAccessibilityToTTSRequest(request, settings) {
  // Ensure that the speed value is a number
  const speed = parseFloat(settings.speed) || 1.0;
  // Since we're not using SSML, leave the request unchanged
  return request;
}

// Function to detect language of text (simplified version)
function detectLanguage(text) {
  // This is a simplified language detection
  // In a real implementation, you would use a proper language detection library
  const langPatterns = {
    en: /\b(the|and|is|in|to|of|that|for|it|with|as|be|on|not|this|but|by|from|or|have|an|they|which|one|you|were|all|their|are|was|at)\b/gi,
    es: /\b(el|la|los|las|un|una|unos|unas|y|en|de|que|por|con|para|se|no|como|más|este|esta|estos|estas|ese|esa|esos|esas|aquel|aquella)\b/gi,
    fr: /\b(le|la|les|un|une|des|et|en|de|que|qui|pour|dans|ce|cette|ces|sur|avec|pas|plus|tout|tous|toute|toutes|autre|autres)\b/gi,
    de: /\b(der|die|das|ein|eine|und|in|zu|von|für|mit|auf|ist|sind|war|waren|wird|werden|nicht|auch|als|bei|aus|nach|wenn|dann)\b/gi
  };
  
  // Count matches for each language
  const counts = {};
  for (const [lang, pattern] of Object.entries(langPatterns)) {
    const matches = text.match(pattern) || [];
    counts[lang] = matches.length;
  }
  
  // Find language with most matches
  let detectedLang = 'en'; // Default to English
  let maxCount = 0;
  
  for (const [lang, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      detectedLang = lang;
    }
  }
  
  return detectedLang;
}

// Export functions for use in other modules
export {
  defaultAccessibilitySettings,
  saveAccessibilitySettings,
  loadAccessibilitySettings,
  applyAccessibilityToTTSRequest,
  detectLanguage
};
