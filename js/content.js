// At the top of your content.js file
if (!window.auraspeechInitialized) {
  // Set the flag first
  window.auraspeechInitialized = true;
  
  // Enhanced content.js with robust message handling and debugging
  console.log("AuraSpeech content script loaded at", new Date().toISOString());
  
  // Content script to handle text selection and UI elements
  let stopButtonContainer = null;
  
  // Immediately notify background script that content script is loaded
  try {
    console.log("Sending contentScriptLoaded message to background script");
    chrome.runtime.sendMessage({
      action: "contentScriptLoaded",
      url: window.location.href,
      timestamp: Date.now()
    }, response => {
      if (chrome.runtime.lastError) {
        console.error("Error sending contentScriptLoaded message:", chrome.runtime.lastError);
      } else {
        console.log("Background script acknowledged content script load:", response);
      }
    });
  } catch (error) {
    console.error("Failed to send contentScriptLoaded message:", error);
  }
  
  // Listen for messages from the background script
  try {
    console.log("Setting up message listener in content script");
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log("Content script received message:", message);
      
      try {
        switch (message.action) {
          case "getSelectedText":
            const selectedText = window.getSelection().toString();
            console.log("Selected text length:", selectedText.length);
            sendResponse({ selectedText: selectedText });
            break;
            
          case "showAlert":
            alert(message.message);
            sendResponse({ success: true });
            break;
            
          case "showLoading":
            showLoadingIndicator();
            sendResponse({ success: true });
            break;
            
          case "hideLoading":
            hideLoadingIndicator();
            sendResponse({ success: true });
            break;
            
          case "showStopButton":
            showStopButton();
            sendResponse({ success: true });
            break;
            
          case "hideStopButton":
            hideStopButton();
            sendResponse({ success: true });
            break;
            
          case "updatePauseState":
            updatePauseButtonState(message.isPaused);
            sendResponse({ success: true });
            break;
            
          case "ping":
            console.log("Received ping from background script");
            sendResponse({ pong: true, timestamp: Date.now() });
            break;
            
          default:
            console.log("Unknown action:", message.action);
            sendResponse({ error: "Unknown action" });
            break;
        }
      } catch (error) {
        console.error("Error handling message in content script:", error);
        sendResponse({ error: error.message });
      }
      
      return true; // Keep the message channel open for async response
    });
    console.log("Message listener setup complete");
  } catch (error) {
    console.error("Failed to set up message listener:", error);
  }
  
  // Function to show loading indicator
  function showLoadingIndicator() {
    console.log("Showing loading indicator");
    try {
      // Create loading indicator if it doesn't exist
      if (!document.getElementById('auraspeech-loading')) {
        const loadingDiv = document.createElement('div');
        loadingDiv.id = 'auraspeech-loading';
        loadingDiv.innerHTML = 'AuraSpeech is processing...';
        loadingDiv.style.cssText = `
          position: fixed;
          bottom: 20px;
          right: 20px;
          background-color: rgba(0, 0, 0, 0.7);
          color: white;
          padding: 10px 15px;
          border-radius: 5px;
          z-index: 10000;
          font-family: Arial, sans-serif;
        `;
        document.body.appendChild(loadingDiv);
      }
    } catch (error) {
      console.error("Error showing loading indicator:", error);
    }
  }
  
  // Function to hide loading indicator
  function hideLoadingIndicator() {
    console.log("Hiding loading indicator");
    try {
      const loadingDiv = document.getElementById('auraspeech-loading');
      if (loadingDiv) {
        loadingDiv.remove();
      }
    } catch (error) {
      console.error("Error hiding loading indicator:", error);
    }
  }
  
  // Function to show stop button
  function showStopButton() {
    console.log("Showing stop button");
    try {
      // Remove existing stop button if it exists
      hideStopButton();
      
      // Create stop button container
      stopButtonContainer = document.createElement('div');
      stopButtonContainer.id = 'auraspeech-stop-container';
      stopButtonContainer.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background-color: white;
        border: 1px solid #ddd;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        padding: 10px;
        z-index: 10000;
        font-family: Arial, sans-serif;
        display: flex;
        flex-direction: column;
        align-items: center;
      `;
      
      // Create title
      const title = document.createElement('div');
      title.textContent = 'AuraSpeech';
      title.style.cssText = `
        font-weight: bold;
        margin-bottom: 8px;
        color: #4285f4;
      `;
      
      // Create stop button
      const stopButton = document.createElement('button');
      stopButton.textContent = 'Stop Speaking';
      stopButton.style.cssText = `
        background-color: #f44336;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 500;
        margin-bottom: 5px;
      `;
      
      // Create pause button
      const pauseButton = document.createElement('button');
      pauseButton.id = 'auraspeech-pause-button';
      pauseButton.textContent = 'Pause';
      pauseButton.style.cssText = `
        background-color: #ff9800;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 500;
      `;
      
      // Add click event to stop button
      stopButton.addEventListener('click', () => {
        console.log("Stop button clicked");
        try {
          chrome.runtime.sendMessage({ action: "stopSpeech" }, (response) => {
            if (chrome.runtime.lastError) {
              console.error("Error sending stopSpeech message:", chrome.runtime.lastError);
            } else {
              console.log("Stop speech response:", response);
            }
          });
          hideStopButton();
        } catch (error) {
          console.error("Error in stop button click handler:", error);
        }
      });
      
      // Add click event to pause button
      pauseButton.addEventListener('click', () => {
        console.log("Pause button clicked");
        try {
          chrome.runtime.sendMessage({ action: "togglePause" }, (response) => {
            if (chrome.runtime.lastError) {
              console.error("Error sending togglePause message:", chrome.runtime.lastError);
            } else {
              console.log("Toggle pause response:", response);
            }
          });
        } catch (error) {
          console.error("Error in pause button click handler:", error);
        }
      });
      
      // Append elements to container
      stopButtonContainer.appendChild(title);
      stopButtonContainer.appendChild(stopButton);
      stopButtonContainer.appendChild(pauseButton);
      
      // Add container to page
      document.body.appendChild(stopButtonContainer);
    } catch (error) {
      console.error("Error showing stop button:", error);
    }
  }
  
  // Function to update pause button state
  function updatePauseButtonState(isPaused) {
    console.log("Updating pause button state:", isPaused);
    try {
      const pauseButton = document.getElementById('auraspeech-pause-button');
      if (pauseButton) {
        if (isPaused) {
          pauseButton.textContent = 'Resume';
          pauseButton.style.backgroundColor = '#4caf50';
        } else {
          pauseButton.textContent = 'Pause';
          pauseButton.style.backgroundColor = '#ff9800';
        }
      }
    } catch (error) {
      console.error("Error updating pause button state:", error);
    }
  }
  
  // Function to hide stop button
  function hideStopButton() {
    console.log("Hiding stop button");
    try {
      if (stopButtonContainer) {
        stopButtonContainer.remove();
        stopButtonContainer = null;
      } else {
        const existingContainer = document.getElementById('auraspeech-stop-container');
        if (existingContainer) {
          existingContainer.remove();
        }
      }
    } catch (error) {
      console.error("Error hiding stop button:", error);
    }
  }
  
  // Periodically check connection with background script
  const connectionInterval = setInterval(() => {
    try {
      chrome.runtime.sendMessage({ action: "ping" }, (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || "";
          if (
            errMsg.includes("Extension context invalidated") ||
            errMsg.includes("Could not establish connection")
          ) {
            clearInterval(connectionInterval);
            console.log("Cleared connection interval due to:", errMsg);
          } else {
            console.error("Connection check failed:", errMsg);
          }
        } else {
          console.log("Connection with background script confirmed:", response);
        }
      });
    } catch (error) {
      if (
        error.message &&
        (error.message.includes("Extension context invalidated") ||
         error.message.includes("Could not establish connection"))
      ) {
        clearInterval(connectionInterval);
        console.log("Cleared connection interval due to:", error.message);
      } else {
        console.error("Error during connection check:", error);
      }
    }
  }, 30000);
  
  // Notify that content script is fully loaded
  console.log("AuraSpeech content script initialization complete at", new Date().toISOString());
} else {
  console.log("AuraSpeech content script already initialized, exiting");
}