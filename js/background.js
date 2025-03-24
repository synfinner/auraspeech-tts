// Fixed background.js for service worker environment with updated API integration
console.log("AuraSpeech background script loaded at", new Date().toISOString());

// Global variables to track audio playback
let isPlaying = false;
let isPaused = false;
let hasOffscreenDocument = false;

// Track content script status for each tab
const contentScriptStatus = {};

// Create context menu item when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed, creating context menu");
  chrome.contextMenus.create({
    id: "speakSelectedText",
    title: "Speak Selected Text",
    contexts: ["selection"]
  });
});

// Handle context menu item click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  console.log("Context menu clicked:", info.menuItemId);
  if (info.menuItemId === "speakSelectedText") {
    console.log("Sending getSelectedText message to tab:", tab.id);
    
    // Check if content script is registered for this tab
    if (!contentScriptStatus[tab.id]) {
      console.log("Content script not registered for tab", tab.id, "attempting to inject");
      
      // Try to inject the content script
      try {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['js/content.js']
        }).then(() => {
          console.log("Content script injected into tab", tab.id);
          
          // Wait a moment for the content script to initialize
          setTimeout(() => {
            sendGetSelectedTextMessage(tab.id);
          }, 500);
        }).catch(error => {
          console.error("Failed to inject content script:", error);
          showErrorToUser(tab.id, "Failed to access page content. Please refresh the page and try again.");
        });
      } catch (error) {
        console.error("Error injecting content script:", error);
        showErrorToUser(tab.id, "Failed to access page content. Please refresh the page and try again.");
      }
    } else {
      // Content script is registered, send message directly
      sendGetSelectedTextMessage(tab.id);
    }
  }
});

// Function to show error to user via content script or notification
function showErrorToUser(tabId, message) {
  console.log("Showing error to user:", message);
  
  // First try to send message to content script
  try {
    chrome.tabs.sendMessage(tabId, { 
      action: "showAlert", 
      message: message
    }, response => {
      if (chrome.runtime.lastError) {
        console.error("Error showing alert via content script:", chrome.runtime.lastError);
        
        // Fallback to chrome notifications
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'images/icon128.png',
          title: 'AuraSpeech Error',
          message: message,
          priority: 2
        });
      }
    });
  } catch (error) {
    console.error("Error sending alert message:", error);
    
    // Fallback to chrome notifications
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'images/icon128.png',
      title: 'AuraSpeech Error',
      message: message,
      priority: 2
    });
  }
}

// Function to send getSelectedText message with retry
function sendGetSelectedTextMessage(tabId) {
  console.log("Sending getSelectedText message to tab", tabId);
  
  // Send message to content script to get the selected text
  chrome.tabs.sendMessage(tabId, { action: "getSelectedText" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error sending message to content script:", chrome.runtime.lastError);
      
      // Try pinging the content script
      chrome.tabs.sendMessage(tabId, { action: "ping" }, (pingResponse) => {
        if (chrome.runtime.lastError) {
          console.error("Ping failed, content script may not be loaded:", chrome.runtime.lastError);
          
          // Try injecting the content script again
          try {
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['js/content.js']
            }).then(() => {
              console.log("Content script re-injected into tab", tabId);
              
              // Wait a moment for the content script to initialize
              setTimeout(() => {
                // Try one more time
                chrome.tabs.sendMessage(tabId, { action: "getSelectedText" }, (retryResponse) => {
                  if (chrome.runtime.lastError) {
                    console.error("Final retry failed:", chrome.runtime.lastError);
                    showErrorToUser(tabId, "Failed to access selected text. Please refresh the page and try again.");
                  } else if (retryResponse && retryResponse.selectedText) {
                    processTextToSpeech(retryResponse.selectedText.trim(), tabId);
                  }
                });
              }, 500);
            }).catch(error => {
              console.error("Failed to re-inject content script:", error);
              showErrorToUser(tabId, "Failed to access page content. Please refresh the page and try again.");
            });
          } catch (error) {
            console.error("Error re-injecting content script:", error);
            showErrorToUser(tabId, "Failed to access page content. Please refresh the page and try again.");
          }
        } else {
          console.log("Ping successful but getSelectedText failed, retrying");
          
          // Try one more time
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: "getSelectedText" }, (retryResponse) => {
              if (chrome.runtime.lastError) {
                console.error("Retry failed after successful ping:", chrome.runtime.lastError);
                showErrorToUser(tabId, "Failed to access selected text. Please refresh the page and try again.");
              } else if (retryResponse && retryResponse.selectedText) {
                processTextToSpeech(retryResponse.selectedText.trim(), tabId);
              }
            });
          }, 100);
        }
      });
    } else if (response && response.selectedText) {
      processTextToSpeech(response.selectedText.trim(), tabId);
    } else {
      console.error("Invalid response from content script:", response);
    }
  });
}

// Process text to speech with accessibility features
async function processTextToSpeech(selectedText, tabId) {
  console.log("Processing text to speech, length:", selectedText.length);
  
  // Check if there's already audio playing
  if (isPlaying) {
    console.log("Audio already playing, stopping current speech");
    stopSpeech();
  }
  
  // Check word count
  const wordCount = selectedText.split(/\s+/).length;
  console.log("Word count:", wordCount);
  
  if (wordCount > 2000) {
    console.log("Word count exceeds limit, showing alert");
    showErrorToUser(tabId, "Selected text exceeds 2000 words. Please select less text to avoid high API costs.");
    return;
  }
  
  // Get API key and accessibility settings from storage
  console.log("Getting API key and settings from storage");
  try {
    chrome.storage.local.get(['apiKey', 'voice', 'accessibilitySettings'], async (settings) => {
      console.log("Got settings:", JSON.stringify({
        hasApiKey: !!settings.apiKey,
        voice: settings.voice,
        hasAccessibilitySettings: !!settings.accessibilitySettings
      }));
      
      if (!settings.apiKey) {
        console.log("No API key found, showing alert");
        showErrorToUser(tabId, "Please set your OpenAI API key in the extension settings.");
        return;
      }
      
      try {
        // Send message to content script to show loading indicator
        console.log("Showing loading indicator");
        try {
          chrome.tabs.sendMessage(tabId, { action: "showLoading" }, response => {
            if (chrome.runtime.lastError) {
              console.error("Error showing loading indicator:", chrome.runtime.lastError);
            }
          });
        } catch (error) {
          console.error("Error sending showLoading message:", error);
        }
        
        // Prepare TTS request
        const voice = settings.voice || 'nova';
        console.log("Using voice:", voice);
        
        // Apply accessibility settings to the request
        let instructions = "Accent/Affect: Warm, refined, and gently instructive, reminiscent of a friendly professor or podcast host.\n\nTone: Calm, encouraging, and articulate, clearly describing each step with patience.\n\nPacing: fast and deliberate, pausing to allow the listener to follow instructions comfortably. \n\nEmotion: Cheerful, supportive, and pleasantly enthusiastic; convey genuine enjoyment and appreciation of art.\n\nPronunciation: Clearly articulates terminology with gentle emphasis.\n\nPersonality Affect: Friendly and approachable with a hint of sophistication; speak confidently and reassuringly, guiding users through each content patiently and warmly.";
        
        if (settings.accessibilitySettings) {
          // Auto-detect language if enabled
          if (settings.accessibilitySettings.autoDetectLanguage) {
            const detectedLang = detectLanguage(selectedText);
            console.log(`Detected language: ${detectedLang}`);
          }
          
          // Apply speed adjustment if different from default
          if (settings.accessibilitySettings.speed !== 1.0) {
            console.log(`Using speech rate: ${settings.accessibilitySettings.speed}x`);
            // Don't add this to instructions since we're handling speed in Web Audio API
            // instructions += `\n\nSpeed: ${settings.accessibilitySettings.speed}x`;
          }
        }
        
        // Call OpenAI TTS API
        console.log("Calling OpenAI TTS API");
        try {
          const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${settings.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini-tts',  // Updated to use the model from the curl example
              voice: voice,
              speed: Math.max(0.25, Math.min(4.0, parseFloat(settings.accessibilitySettings?.speed || 1.0))),
              input: selectedText,
              instructions: instructions,
              response_format: 'wav'  // Updated to use WAV format from the curl example
            })
          });
          // show the full request body in console
          console.log("Request body:", JSON.stringify({
            model: 'gpt-4o-mini-tts',
            voice: voice,
            speed: Math.max(0.25, Math.min(4.0, parseFloat(settings.accessibilitySettings?.speed || 1.0))),
            input: selectedText,
            instructions: instructions,
            response_format: 'wav'
          }));
          
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error("OpenAI API error response:", errorData);
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText} ${JSON.stringify(errorData)}`);
          }
          
          console.log("OpenAI TTS API call successful");
          
          // Convert response to ArrayBuffer
          console.log("Converting response to ArrayBuffer");
          const audioData = await response.arrayBuffer();
          console.log("Got ArrayBuffer of size:", audioData.byteLength);
          
          // Create an offscreen document for audio playback
          try {
            // Create an offscreen document for audio playback using a more compatible approach
            await createOffscreenDocumentIfNeeded();
            
            // Send the audio data to the offscreen document for playback
            await playAudioInOffscreenDocument(audioData);
            
            // Set playing state
            isPlaying = true;
            isPaused = false;
            
            // Send message to content script to hide loading indicator
            console.log("Hiding loading indicator");
            try {
              chrome.tabs.sendMessage(tabId, { action: "hideLoading" }, response => {
                if (chrome.runtime.lastError) {
                  console.error("Error hiding loading indicator:", chrome.runtime.lastError);
                }
              });
            } catch (error) {
              console.error("Error sending hideLoading message:", error);
            }
            
            // Add stop button to the page
            console.log("Showing stop button");
            try {
              chrome.tabs.sendMessage(tabId, { action: "showStopButton" }, response => {
                if (chrome.runtime.lastError) {
                  console.error("Error showing stop button:", chrome.runtime.lastError);
                }
              });
            } catch (error) {
              console.error("Error sending showStopButton message:", error);
            }
          } catch (offscreenError) {
            console.error("Error with offscreen document:", offscreenError);
            showErrorToUser(tabId, "Error playing audio: " + offscreenError.message);
          }
        } catch (error) {
          console.error('Error generating speech:', error);
          showErrorToUser(tabId, `Error: ${error.message}`);
          
          try {
            chrome.tabs.sendMessage(tabId, { action: "hideLoading" }, response => {
              if (chrome.runtime.lastError) {
                console.error("Error hiding loading indicator after error:", chrome.runtime.lastError);
              }
            });
          } catch (hideError) {
            console.error("Error sending hideLoading message after error:", hideError);
          }
        }
      } catch (error) {
        console.error("Error in TTS process:", error);
        showErrorToUser(tabId, `Error: ${error.message}`);
      }
    });
  } catch (error) {
    console.error("Error getting settings from storage:", error);
    showErrorToUser(tabId, `Error: ${error.message}`);
  }
}

// More compatible approach to create offscreen document
async function createOffscreenDocumentIfNeeded() {
  if (hasOffscreenDocument) {
    console.log("Offscreen document already exists");
    return;
  }

  // Check if offscreen document exists using a more compatible approach
  try {
    // Try to send a message to the offscreen document
    // If it doesn't exist, this will throw an error
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'ping'
    }).catch(() => {
      // Expected error if document doesn't exist
      throw new Error('Offscreen document does not exist');
    });
    
    // If we get here, the document exists
    hasOffscreenDocument = true;
    console.log("Offscreen document exists");
  } catch (error) {
    console.log("Creating new offscreen document");
    
    // Create the offscreen document
    try {
      await chrome.offscreen.createDocument({
        url: 'html/offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play TTS audio'
      });
      hasOffscreenDocument = true;
      console.log("Created offscreen document for audio playback");
    } catch (createError) {
      console.error("Error creating offscreen document:", createError);
      throw createError;
    }
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Background script received message:", message, "from tab:", sender.tab?.id);
  
  try {
    switch (message.action) {
      case "contentScriptLoaded":
        console.log("Content script loaded in tab", sender.tab.id, "at URL:", message.url);
        contentScriptStatus[sender.tab.id] = {
          loaded: true,
          url: message.url,
          timestamp: message.timestamp
        };
        sendResponse({ acknowledged: true });
        break;
        
      case "stopSpeech":
        console.log("Stopping speech");
        stopSpeech();
        sendResponse({ success: true });
        break;
        
      case "togglePause":
        console.log("Toggling pause state");
        togglePause();
        sendResponse({ success: true });
        break;
        
      case "speakSelectedText":
        console.log("Speaking selected text from message");
        if (message.selectedText) {
          processTextToSpeech(message.selectedText, sender.tab.id);
        }
        sendResponse({ success: true });
        break;
        
      case "ping":
        console.log("Received ping from tab", sender.tab?.id);
        sendResponse({ pong: true, timestamp: Date.now() });
        break;
        
      case "audioEnded":
        console.log("Audio playback ended");
        isPlaying = false;
        isPaused = false;
        
        // Remove stop button when audio ends
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            console.log("Hiding stop button after playback end");
            chrome.tabs.sendMessage(tabs[0].id, { action: "hideStopButton" }, response => {
              if (chrome.runtime.lastError) {
                console.error("Error hiding stop button after playback end:", chrome.runtime.lastError);
              }
            });
          }
        });
        sendResponse({ success: true });
        break;
        
      case "updatePlaybackSpeed":
        console.log("Received request to update playback speed to:", message.speed);
        if (hasOffscreenDocument) {
          console.log("Forwarding speed change to offscreen document");
          chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'setPlaybackRate',
            speed: message.speed
          }).then(() => {
            console.log("Speed change request sent successfully");
          }).catch(error => {
            console.error("Error sending speed change request:", error);
          });
        } else {
          console.warn("No offscreen document available for speed change");
        }
        sendResponse({ success: true });
        break;
        
      default:
        console.log("Unknown action:", message.action);
        sendResponse({ error: "Unknown action" });
        break;
    }
  } catch (error) {
    console.error("Error handling message in background script:", error);
    sendResponse({ error: error.message });
  }
  
  return true; // Keep the message channel open for async response
});

// Function to stop speech
function stopSpeech() {
  console.log("Stopping speech, isPlaying:", isPlaying);
  try {
    if (isPlaying) {
      console.log("Sending stop message to offscreen document");
      chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'stopAudio'
      });
      
      isPlaying = false;
      isPaused = false;
      
      // Remove stop button
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          console.log("Hiding stop button after manual stop");
          chrome.tabs.sendMessage(tabs[0].id, { action: "hideStopButton" }, response => {
            if (chrome.runtime.lastError) {
              console.error("Error hiding stop button after manual stop:", chrome.runtime.lastError);
            }
          });
        }
      });
    }
  } catch (error) {
    console.error("Error in stopSpeech function:", error);
  }
}

// Function to toggle pause/resume
function togglePause() {
  console.log("Toggling pause state, isPlaying:", isPlaying, "isPaused:", isPaused);
  try {
    if (!isPlaying) {
      console.log("Cannot toggle pause: not playing");
      return;
    }
    
    if (isPaused) {
      // Resume playback
      console.log("Resuming audio playback");
      chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'resumeAudio'
      });
      isPaused = false;
    } else {
      // Pause playback
      console.log("Pausing audio playback");
      chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'pauseAudio'
      });
      isPaused = true;
    }
    
    // Update UI to reflect pause state
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        console.log("Updating pause button state, isPaused:", isPaused);
        chrome.tabs.sendMessage(tabs[0].id, { 
          action: "updatePauseState", 
          isPaused: isPaused 
        }, response => {
          if (chrome.runtime.lastError) {
            console.error("Error updating pause button state:", chrome.runtime.lastError);
          }
        });
      }
    });
  } catch (error) {
    console.error("Error in togglePause function:", error);
  }
}

// Helper function to detect language (simplified)
function detectLanguage(text) {
  console.log("Detecting language for text of length:", text.length);
  try {
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
    
    console.log("Detected language:", detectedLang, "with", maxCount, "matches");
    return detectedLang;
  } catch (error) {
    console.error("Error in detectLanguage function:", error);
    return 'en'; // Default to English on error
  }
}

// Clean up tab tracking when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  console.log("Tab closed, removing from content script status tracking:", tabId);
  delete contentScriptStatus[tabId];
});

// Updated code using chrome.storage.local for accessibilitySettings
chrome.storage.local.get('accessibilitySettings', (result) => {
  const settings = result.accessibilitySettings || { speed: 1.0 };
  // ... use settings ...
});

console.log("AuraSpeech background script initialization complete at", new Date().toISOString());

// In your playAudio function
async function playAudioInOffscreenDocument(audioData) {
  console.log("Sending audio to offscreen document");
  
  // Create offscreen document if needed
  if (!hasOffscreenDocument) {
    await createOffscreenDocumentIfNeeded();  // Use the correct function name
  }
  
  // Send audio data to offscreen document (no speed needed)
  return chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'playAudio',
    audioData: Array.from(new Uint8Array(audioData))
  });
}
