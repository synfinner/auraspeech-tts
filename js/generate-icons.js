// Create a simple SVG icon for AuraSpeech
const canvas = document.createElement('canvas');
canvas.width = 128;
canvas.height = 128;
const ctx = canvas.getContext('2d');

// Background gradient
const gradient = ctx.createLinearGradient(0, 0, 128, 128);
gradient.addColorStop(0, '#4285f4');  // Google blue
gradient.addColorStop(1, '#34a853');  // Google green
ctx.fillStyle = gradient;
ctx.fillRect(0, 0, 128, 128);

// Sound wave icon
ctx.strokeStyle = 'white';
ctx.lineWidth = 4;
ctx.beginPath();

// Draw sound waves
const centerX = 64;
const centerY = 64;

// Small wave
ctx.beginPath();
ctx.arc(centerX, centerY, 20, Math.PI * 0.25, Math.PI * 0.75, false);
ctx.stroke();

// Medium wave
ctx.beginPath();
ctx.arc(centerX, centerY, 35, Math.PI * 0.25, Math.PI * 0.75, false);
ctx.stroke();

// Large wave
ctx.beginPath();
ctx.arc(centerX, centerY, 50, Math.PI * 0.25, Math.PI * 0.75, false);
ctx.stroke();

// Draw letter "A" for Aura
ctx.fillStyle = 'white';
ctx.font = 'bold 60px Arial';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('A', centerX, centerY);

// Export to PNG files of different sizes
const sizes = [16, 48, 128];
sizes.forEach(size => {
  const resizedCanvas = document.createElement('canvas');
  resizedCanvas.width = size;
  resizedCanvas.height = size;
  const resizedCtx = resizedCanvas.getContext('2d');
  resizedCtx.drawImage(canvas, 0, 0, size, size);
  
  const imageData = resizedCanvas.toDataURL('image/png');
  const fileName = `icon${size}.png`;
  
  // In a real environment, we would save this file
  console.log(`Generated ${fileName}`);
});
