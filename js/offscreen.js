// Audio playback variables
let audioContext = null;
let audioSource = null;
let originalAudioBuffer = null; // Store the original buffer for pitch-correct playback

// Initialize audio context
function initializeAudioContext() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log("AudioContext initialized in offscreen document");
    }
  } catch (error) {
    console.error("Error initializing AudioContext in offscreen document:", error);
  }
}

// Handle messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') {
    return;
  }
  
  console.log("Offscreen document received message:", message.action);
  
  switch (message.action) {
    case 'ping':
      console.log("Received ping in offscreen document");
      sendResponse({ pong: true });
      break;
      
    case 'playAudio':
      playAudio(message.audioData); // No longer needs speed parameter
      sendResponse({ success: true });
      break;
      
    case 'pauseAudio':
      pauseAudio();
      sendResponse({ success: true });
      break;
      
    case 'resumeAudio':
      resumeAudio();
      sendResponse({ success: true });
      break;
      
    case 'stopAudio':
      stopAudio();
      sendResponse({ success: true });
      break;

    case 'setPlaybackRate':
      setPlaybackRate(message.speed);
      sendResponse({ success: true });
      break;
  }
  
  return true; // Keep the message channel open for async response
});

// Play audio from array buffer - now without speed manipulation
function playAudio(audioDataArray) {
  console.log("Playing audio, buffer size:", audioDataArray.length);
  
  try {
    initializeAudioContext();
    stopAudio(); // Stop currently playing audio if needed

    // Convert array back to ArrayBuffer
    const audioData = new Uint8Array(audioDataArray).buffer;
    
    // Decode audio
    audioContext.decodeAudioData(audioData, (buffer) => {
      console.log("Audio decoded successfully, duration:", buffer.duration);
      
      // Create a new audio source
      audioSource = audioContext.createBufferSource();
      audioSource.buffer = buffer;
      
      // Connect the source to the audio destination (speakers)
      audioSource.connect(audioContext.destination);
      
      // Start playback
      if (audioContext.state !== "running") {
        audioContext.resume().then(() => {
          audioSource.start(0);
        }).catch(err => {
          console.error("Failed to resume AudioContext:", err);
        });
      } else {
        audioSource.start(0);
      }
      
      // When audio ends, notify the background script
      audioSource.onended = () => {
        console.log("Audio playback ended");
        audioSource = null;
        chrome.runtime.sendMessage({ action: "audioEnded" });
      };
    }, (error) => {
      console.error("Error decoding audio data:", error);
    });
  } catch (error) {
    console.error("Error playing audio:", error);
  }
}

// Pause audio playback
function pauseAudio() {
  console.log("Pausing audio");
  try {
    if (audioContext && audioContext.state === "running") {
      audioContext.suspend();
      console.log("Audio paused");
    }
  } catch (error) {
    console.error("Error pausing audio:", error);
  }
}

// Resume audio playback
function resumeAudio() {
  console.log("Resuming audio");
  try {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume();
      console.log("Audio resumed");
    }
  } catch (error) {
    console.error("Error resuming audio:", error);
  }
}

// Stop audio playback
function stopAudio() {
  console.log("Stopping audio");
  try {
    // Stop the audio source if it exists
    if (audioSource) {
      audioSource.stop();
      audioSource.disconnect();
      audioSource = null;
      console.log("Audio source stopped and disconnected");
    }
    
    // Optionally close and recreate the audio context
    if (audioContext) {
      audioContext.close().then(() => {
        console.log("AudioContext closed");
        audioContext = new AudioContext();
        console.log("New AudioContext created");
      }).catch(error => {
        console.error("Error closing AudioContext:", error);
      });
    }
  } catch (error) {
    console.error("Error stopping audio:", error);
  }
}

// Function to change playback speed of ongoing playback
function setPlaybackRate(speed) {
  // Stop current playback and restart with new speed
  if (audioSource && originalAudioBuffer) {
    const currentTime = audioSource.context.currentTime - audioSource.startTime || 0;
    
    // Stop the current playback
    stopAudio();
    
    // Start new playback with the adjusted speed
    startPlaybackWithSpeed(speed);
    
    console.log("Updated playback speed to:", speed);
  } else {
    console.warn("Cannot adjust playback speed - no active audio source");
  }
}

// Initialize when the document loads
document.addEventListener('DOMContentLoaded', () => {
  console.log("Offscreen document loaded");
  // Initialize audio context on load
  initializeAudioContext();
});

console.log("Offscreen document script loaded");