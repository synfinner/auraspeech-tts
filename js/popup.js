document.addEventListener('DOMContentLoaded', () => {
  console.log("Simple popup loaded");
  
  // Get DOM elements
  const apiKeyInput = document.getElementById('apiKey');
  const voiceSelect = document.getElementById('voice');
  const speedInput = document.getElementById('speed');
  const speedValueSpan = document.getElementById('speedValue');
  const saveButton = document.getElementById('saveButton');
  const statusElement = document.getElementById('status');
  const keyStatusElement = document.getElementById('keyStatus');
  const testButton = document.getElementById('testButton');
  const testResult = document.getElementById('testResult');
  const testArea = document.getElementById('testArea');
  // Note: Removed "speedDisplay" since our HTML uses "speedValue"
  
  console.log("DOM elements retrieved");

  // Show status message
  function showStatus(message, type) {
    console.log(`Status: ${message} (${type})`);
    statusElement.textContent = message;
    statusElement.className = 'status ' + type;
    statusElement.style.display = 'block';
    
    clearTimeout(window.statusTimeout);
    window.statusTimeout = setTimeout(() => {
      statusElement.style.display = 'none';
    }, 5000);
  }

  // Update key status indicator
  function updateKeyStatus(hasKey) {
    if (hasKey) {
      keyStatusElement.textContent = "✓ API key is saved";
      keyStatusElement.style.color = "#28a745";
      testArea.style.display = "block";
    } else {
      keyStatusElement.textContent = "✗ No API key saved";
      keyStatusElement.style.color = "#dc3545";
      testArea.style.display = "none";
    }
  }

  // Load saved settings (API key and voice)
  console.log("Loading saved settings");
  chrome.storage.local.get(['apiKey', 'voice'], (result) => {
    console.log("Settings loaded:", {
      hasApiKey: !!result.apiKey,
      voice: result.voice || 'not set'
    });
    
    if (result.apiKey) {
      // Show masked API key for security
      apiKeyInput.value = '••••••••' + result.apiKey.slice(-4);
      apiKeyInput.dataset.masked = 'true';
      apiKeyInput.dataset.originalKey = result.apiKey;
      updateKeyStatus(true);
      console.log("API key loaded and masked");
    } else {
      updateKeyStatus(false);
      console.log("No API key found in storage");
    }
    
    if (result.voice) {
      voiceSelect.value = result.voice;
    }
  });

  // Load accessibility settings (playback speed) from chrome.storage.local
  chrome.storage.local.get('accessibilitySettings', (result) => {
    const accessibilitySettings = result.accessibilitySettings || { speed: 1.0 };
    speedInput.value = accessibilitySettings.speed;
    speedValueSpan.textContent = accessibilitySettings.speed;
    console.log("Playback speed loaded:", accessibilitySettings.speed);
  });

  // Update speedValue display as slider moves
  speedInput.addEventListener('input', () => {
    speedValueSpan.textContent = speedInput.value;
  });

  // Handle API key input focus to clear masked value
  apiKeyInput.addEventListener('focus', () => {
    if (apiKeyInput.dataset.masked === 'true') {
      apiKeyInput.value = '';
      apiKeyInput.dataset.masked = 'false';
      console.log("API key input field cleared for editing");
    }
  });

  // Save settings
  saveButton.addEventListener('click', () => {
    console.log("Save button clicked");
    const apiKey = apiKeyInput.value.trim();
    const voice = voiceSelect.value;
    const speed = parseFloat(speedInput.value);
    
    // Prepare save data
    const saveData = { voice };

    // Handle API key logic
    if (apiKeyInput.dataset.masked === 'true' && apiKeyInput.dataset.originalKey) {
      console.log("Using original masked API key");
      saveData.apiKey = apiKeyInput.dataset.originalKey;
    } else if (apiKey) {
      console.log("Using new API key");
      saveData.apiKey = apiKey;
    } else {
      console.log("No API key provided");
      showStatus('Please enter your OpenAI API key', 'error');
      return;
    }

    console.log("Saving settings to chrome.storage.local");
    chrome.storage.local.set(saveData, () => {
      if (chrome.runtime.lastError) {
        console.error("Error saving settings:", chrome.runtime.lastError);
        showStatus('Error saving settings: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      
      console.log("Settings saved successfully");
      showStatus('Settings saved successfully!', 'success');
      
      // Update the UI to show masked API key
      if (apiKey && apiKeyInput.dataset.masked !== 'true') {
        apiKeyInput.value = '••••••••' + apiKey.slice(-4);
        apiKeyInput.dataset.masked = 'true';
        apiKeyInput.dataset.originalKey = apiKey;
        console.log("API key masked in UI");
      }
      
      updateKeyStatus(true);
      
      // Also save the accessibility settings (playback speed) to chrome.storage.local
      const accessibilitySettings = { speed };
      chrome.storage.local.set({ accessibilitySettings }, () => {
        if (chrome.runtime.lastError) {
          console.error("Error saving accessibility settings:", chrome.runtime.lastError);
        } else {
          console.log("Accessibility settings saved:", accessibilitySettings);
        }
      });

      // Verify the API key save
      chrome.storage.local.get(['apiKey'], (result) => {
        if (result.apiKey) {
          console.log("API key verification successful");
          console.log("Stored key ends with:", result.apiKey.slice(-4));
        } else {
          console.error("API key verification failed - key not found after save");
          showStatus('Warning: API key may not have saved correctly', 'error');
          updateKeyStatus(false);
        }
      });
    });
  });
  
  // Test API key
  testButton.addEventListener('click', () => {
    console.log("Test button clicked");
    testResult.textContent = "Testing API key...";
    testResult.style.color = "#666";
    
    chrome.storage.local.get(['apiKey'], async (result) => {
      if (!result.apiKey) {
        testResult.textContent = "No API key found. Please save an API key first.";
        testResult.style.color = "#dc3545";
        return;
      }
      
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${result.apiKey}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.ok) {
          testResult.textContent = "API key is valid! Connection to OpenAI successful.";
          testResult.style.color = "#28a745";
        } else {
          const errorData = await response.json().catch(() => ({}));
          testResult.textContent = `API key error: ${response.status} ${response.statusText}`;
          testResult.style.color = "#dc3545";
          console.error("API test error:", errorData);
        }
      } catch (error) {
        testResult.textContent = `Error testing API key: ${error.message}`;
        testResult.style.color = "#dc3545";
        console.error("API test exception:", error);
      }
    });
  });

  // Load and initialize the slider value again (from chrome.storage.local)
  chrome.storage.local.get('accessibilitySettings', (result) => {
    const settings = result.accessibilitySettings || { speed: 1.0 };
    speedInput.value = settings.speed;
    speedValueSpan.textContent = settings.speed;
  });

  // When the slider value changes, update the display and save the new speed to chrome.storage.local
  speedInput.addEventListener('input', () => {
    const speed = parseFloat(speedInput.value);
    speedValueSpan.textContent = speed;
    chrome.storage.local.get('accessibilitySettings', (result) => {
      const settings = result.accessibilitySettings || {};
      settings.speed = speed;
      chrome.storage.local.set({ accessibilitySettings: settings }, () => {
        console.log("Updated speed in storage to:", speed);
        
        // Also update any currently playing audio
        chrome.runtime.sendMessage({
          action: "updatePlaybackSpeed",
          speed: speed
        });
      });
    });
  });
});
