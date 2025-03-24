# AuraSpeech TTS - Chrome Extension

AuraSpeech is an accessibility-focused Chrome extension that converts selected text on websites to speech using OpenAI's Text-to-Speech API. It helps users listen to website content, making the web more accessible.

## Features

- Convert selected text to speech with a simple right-click
- Choose from multiple voice options
- Auto-detect language of selected text
- Word count validation to control API costs

## Security Considerations

- The API Key is currently stored locally--and unencrypted--in Chrome's local storage

## Current Issues

- The gpt-4o-mini-tts seems to not handle the `speed` parameter yet, unlike other tts models. Or I just don't know enough yet. I'm working on it.

## Other Considerations

- Please keep in mind that processing TTS can become quite expensive. Be mindful of how much text you're sending to the API. Monitor your usage carefully.
- This extension is very early-stage and may contain bugs. Use at your own risk.

## Installation Instructions

### Prerequisites

- Google Chrome-based browser
- OpenAI API key (sign up at https://platform.openai.com if you don't have one)

### Installation Steps

1. Download the extension files or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" by toggling the switch in the top-right corner
4. Click "Load unpacked" and select the `auraspeech-tts` folder
5. The AuraSpeech extension icon should appear in your Chrome toolbar

## Setup

1. Click on the AuraSpeech icon in your Chrome toolbar
2. Enter your OpenAI API key in the settings popup
3. Choose your preferred voice and accessibility options
4. Click "Save Settings"

## Usage

### Basic Usage

1. Select text on any webpage
2. Right-click on the selected text
3. Choose "Speak Selected Text" from the context menu
4. Listen to the text being read aloud

### Word Count Limit

To control API costs, AuraSpeech will display a warning if you try to convert more than 2000 words to speech at once.

## Development

### Project Structure

```
openai-tts-extension/
├── css/
│   └── popup.css
├── html/
│   └── popup.html
├── images/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── js/
│   ├── accessibility.js
│   ├── background.js
│   ├── content.js
│   └── popup.js
└── manifest.json
```

### Technologies Used

- JavaScript
- Chrome Extension API
- OpenAI Text-to-Speech API

## Security Considerations

- Your API key is stored securely in Chrome's storage sync API
- The extension only requests necessary permissions
- API key is masked in the UI after entry

## License

This project is available for personal and educational use.

## Acknowledgements

- OpenAI for providing the Text-to-Speech API
- Chrome Extension documentation and community
