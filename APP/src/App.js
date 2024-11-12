// src/App.js
import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import io from 'socket.io-client'
function App() {
  // State variables to manage recording status and conversation messages
  const [isRecording, setIsRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  let audioChunks = [];
  let isPlaying = false;
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const wsRef = useRef(null);
  const audioPlayerRef = useRef(null); 
  const audioBufferRef = useRef([]); 


  useEffect(() => {
    const socket = io('url', {
      query: {
        token: 'token'
      }
    });

    socket.on('connect', () => {
      console.log('Connected to backend WebSocket');
      setMessages((prev) => [
        ...prev,
        { role: 'system', text: 'Connected to assistant.' },
      ]);
    });

    socket.on('responseMessage',  (event) => {
      try {
        processServerMessage(event)
      } catch (error) {
        console.error('Error handling incoming message:', error);
      }
    });

    socket.on('disconnect', () => {
      console.log('WebSocket connection closed');
      setMessages((prev) => [
        ...prev,
        { role: 'system', text: 'Disconnected from assistant.' },
      ]);
    });
   
    wsRef.current = socket;

    // Cleanup WebSocket connection on component unmount
    return () => {
      socket.close();
    };
  }, []);



  const processServerMessage = (data) => {
    try {
      switch (data.type) {
        case 'response.audio.delta':
          handleResponseAudioDelta(data);
          break;
        case 'response.audio.done':
          handleResponseAudioDone(data);
          break;
        case 'response.audio_transcript.done':
          handleResponseAudioTranscriptDone(data);
          break;
        default:
          console.log('Unhandled event type:', data.type);
      }
    } catch (error) {
      console.error('Error parsing JSON:', error);
    }
  };



function playChunks() {
    let sampleRate = 24000; // Ajusta la tasa de muestreo a la de tu fuente de audio
    if (audioChunks.length === 0 || isPlaying) return; // No hacer nada si ya está reproduciendo o no hay chunks

    isPlaying = true; // Marcar como reproduciendo
    const chunk = audioChunks.shift(); // Obtener el primer "chunk"

    // Decodificar Base64 y convertir a ArrayBuffer
    const byteCharacters = atob(chunk);
    const byteNumbers = new Uint8Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }

    const buffer = audioContext.createBuffer(1, byteNumbers.length / 2, sampleRate);
    const channelData = buffer.getChannelData(0);

    // Copiar los datos PCM16 al AudioBuffer y normalizar
    for (let i = 0; i < byteNumbers.length; i += 2) {
        const sample = (byteNumbers[i] | (byteNumbers[i + 1] << 8)) << 16 >> 16; // Convertir a signed 16-bit
        channelData[i / 2] = sample / 32767; // Normalizar a Float32
    }

    // Crear el source y conectarlo al contexto de audio
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    // Aplicar un fundido suave al inicio y al final (opcional)
    const fadeDuration = 0.0001; // Duración del fundido en segundos
    const length = channelData.length;
    for (let i = 0; i < Math.floor(fadeDuration * sampleRate); i++) {
        channelData[i] *= i / (fadeDuration * sampleRate); // Fundido al inicio
        channelData[length - i - 1] *= i / (fadeDuration * sampleRate); // Fundido al final
    }

    source.start();

    // Al terminar la reproducción, reproducir el siguiente "chunk" si hay más
    source.onended = function () {
        isPlaying = false; // Marcar como no reproduciendo
        playChunks(); // Reproducir el siguiente chunk si existe
    };
}


// Manejo de la respuesta con el nuevo "chunk"
const handleResponseAudioDelta = (data) => {
    const { delta } = data;
    if (delta) {
        audioChunks.push(delta);  // Agregar el nuevo chunk a la cola

        // Si no estamos reproduciendo, iniciar la reproducción
        if (!isPlaying) {
            console.log('starting');
            playChunks();  // Iniciar la reproducción del primer "chunk"
        }
    }
};

 
const handleResponseAudioDone = (data) => {
    console.log('Audio response completed.');
    setMessages((prev) => [
      ...prev,
      { role: 'system', text: 'Audio response completed.' },
    ]);

    // Clear the audio buffer
    audioBufferRef.current = [];
};


const handleResponseAudioTranscriptDone = (data) => {
    const { transcript } = data;
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', text: transcript },
    ]);
  };




const startRecording = async () => {
    setIsRecording(true);
    audioChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.start();

      mediaRecorder.onstart = () => {
        console.log('Recording started');
        setMessages((prev) => [
          ...prev,
          { role: 'system', text: 'Recording started...' },
        ]);
      };

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        console.log('Recording stopped');
        setMessages((prev) => [
          ...prev,
          { role: 'system', text: 'Processing audio...' },
        ]);
        processAudio();
      };

    } catch (error) {
      console.error('Error accessing microphone:', error);
      setIsRecording(false);
      setMessages((prev) => [
        ...prev,
        { role: 'system', text: 'Microphone access denied or unavailable.' },
      ]);
    }
  };

  /**
   * Stops the ongoing audio recording.
   */
  const stopRecording = () => {
    setIsRecording(false);
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
    }
  };

  /**
   * Processes the recorded audio, encodes it to PCM16 mono 24kHz, and sends it to the backend server.
   */
  const processAudio = async () => {
    const blob = new Blob(audioChunksRef.current, { type: 'audio/wav' });

    // Process the audio to PCM16 mono 24kHz using AudioContext
    const processedBase64Audio = await convertBlobToPCM16Mono24kHz(blob);

    if (!processedBase64Audio) {
      console.error('Audio processing failed.');
      setMessages((prev) => [
        ...prev,
        { role: 'system', text: 'Failed to process audio.' },
      ]);
      return;
    }

    // Send the audio event to the backend via WebSocket
   
      wsRef.current.emit('sendMessage',{"audio": processedBase64Audio});
      setMessages((prev) => [
        ...prev,
        { role: 'system', text: 'Audio sent to assistant for processing.' },
      ]);
   
  };



  //  ############  Utility  #############   //
  const convertBlobToPCM16Mono24kHz = async (blob) => {
    try {
      // Initialize AudioContext with target sample rate
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 24000, // Target sample rate
      });

      // Decode the audio data
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      console.log('rex')
      // Downmix to mono if necessary
      let channelData =
        audioBuffer.numberOfChannels > 1
          ? averageChannels(
              audioBuffer.getChannelData(0),
              audioBuffer.getChannelData(1)
            )
          : audioBuffer.getChannelData(0);

      // Convert Float32Array to PCM16
      const pcm16Buffer = float32ToPCM16(channelData);

      // Base64 encode the PCM16 buffer
      const base64Audio = arrayBufferToBase64(pcm16Buffer);

      // Close the AudioContext to free resources
      audioCtx.close();

      return base64Audio;
    } catch (error) {
      console.error('Error processing audio:', error);
      return null;
    }
  };

 
  const averageChannels = (channel1, channel2) => {
    const length = Math.min(channel1.length, channel2.length);
    const result = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      result[i] = (channel1[i] + channel2[i]) / 2;
    }
    return result;
  };

 
  const float32ToPCM16 = (float32Array) => {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(i * 2, s, true); // little-endian
    }
    return buffer;
  };


  const arrayBufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  return (
    <div className="App">
      <h1>OpenAI Realtime API Demo</h1>
      <button onClick={isRecording ? stopRecording : startRecording}>
        {isRecording ? 'Stop Recording' : 'Start Recording'}
      </button>

      <div id="status">{isRecording ? 'Recording...' : 'Idle'}</div>

      <div className="messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.role}`}>
            {msg.text && <p>{msg.text}</p>}
            {msg.audio && (
              <audio controls src={`data:audio/wav;base64,${msg.audio}`} />
            )}
          </div>
        ))}
      </div>

      {/* Hidden audio player for auto-play */}
      <audio ref={audioPlayerRef} style={{ display: 'none' }} />
    </div>
  );
}

export default App;
