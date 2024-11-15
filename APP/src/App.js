// src/App.js
import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import io from 'socket.io-client'

function App() {
  // State variables to manage recording status and conversation messages
  const [isRecording, setIsRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  let muteMic = useRef(false)
  let audioContext = useRef(null)
  let audioChunks = [];
  let carlSpeaking = false;
  const isSpeaking =  useRef(false)
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const wsRef = useRef(null);
  const audioPlayerRef = useRef(null); 
  const NOISE_THRESHOLD = 0.1;
  const SENSITIVITY = 1;
  const SMOOTHING_FACTOR = 0.5;
  const SILENCE_TIMEOUT = 800;
  let analyser = useRef(null);
  let silenceStartTime = useRef(null);
  let volumeLevel = useRef(0)
  let animationFrameId = useRef(null);
  let receivingData = useRef(false)


  /*================== Handles to Servers events ==================*/

  const handleResponseAudioDelta = (data) => {
    const { delta } = data;
    if (delta) {
        audioChunks.push(delta);  // Agregar el nuevo chunk a la cola

        // Si no estamos reproduciendo y hay al menos 5 chunks, iniciar la reproducción
        if (!carlSpeaking && audioChunks.length >= 5) {
            console.log('starting with 5 chunks');
            playChunks();  // Iniciar la reproducción del primer grupo de chunks
        } else if (!carlSpeaking && audioChunks.length > 0 && !receivingData.current) {
            // Si no se están recibiendo más datos y hay chunks restantes, iniciar reproducción con lo que hay
            console.log('starting with remaining chunks');
            playChunks();
        }
    }
};



  const handleResponseAudioTranscriptDone = (data) => {
    const { transcript } = data;
    setMessages((prev) => [ ...prev, { role: 'assistant', text: transcript },]);
  };


  const processServerMessage = (data) => {
    try {
      console.log(data)
      switch (data.type) {
        case 'response_done':
          receivingData.current = false
        case 'response.audio.delta':
          receivingData.current = true
          handleResponseAudioDelta(data);
          break;
        case 'response.audio_transcript.done':
          handleResponseAudioTranscriptDone(data);
          break;
      }
    } catch (error) {
      console.error('Error parsing JSON:', error);
    }
  };



  function playChunks() {
    let sampleRate = 24000; // Ajusta la tasa de muestreo a la de tu fuente de audio
    if (audioChunks.length === 0 || carlSpeaking) {
        if (audioChunks.length === 0 && !carlSpeaking) { // Check if no more chunks and carl isn't speaking
            setTimeout(() => startRecording(), 200);
        }
        return; // No hacer nada si ya está reproduciendo o no hay chunks
    }

    // Tomar hasta 5 chunks, o todos los disponibles si hay menos
    console.log(audioChunks.length)
    let chunksToPlay = audioChunks.splice(0, 5);

    // Combinar los chunks en un solo Uint8Array
    let combinedLength = chunksToPlay.reduce((sum, chunk) => sum + atob(chunk).length, 0);
    let combinedArray = new Uint8Array(combinedLength);
    let offset = 0;

    chunksToPlay.forEach(chunk => {
        const byteCharacters = atob(chunk);
        for (let i = 0; i < byteCharacters.length; i++) {
            combinedArray[offset++] = byteCharacters.charCodeAt(i);
        }
    });

    const buffer = audioContext.current.createBuffer(1, combinedArray.length / 2, sampleRate);
    const channelData = buffer.getChannelData(0);

    // Copiar los datos PCM16 al AudioBuffer y normalizar
    for (let i = 0; i < combinedArray.length; i += 2) {
        const sample = (combinedArray[i] | (combinedArray[i + 1] << 8)) << 16 >> 16; // Convertir a signed 16-bit
        channelData[i / 2] = sample / 32767; // Normalizar a Float32
    }

    // Crear el source y conectarlo al contexto de audio
    const source = audioContext.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.current.destination);

    // Aplicar un fundido suave al inicio y al final (opcional)
    const fadeDuration = 0.001; // Duración del fundido en segundos
    const length = channelData.length;
    for (let i = 0; i < Math.floor(fadeDuration * sampleRate); i++) {
        channelData[i] *= i / (fadeDuration * sampleRate); // Fundido al inicio
        channelData[length - i - 1] *= i / (fadeDuration * sampleRate); // Fundido al final
    }

    carlSpeaking = true; // Marcar como reproduciendo
    source.start();

    // Al terminar la reproducción, reproducir el siguiente "chunk" si hay más
    source.onended = function () {
        carlSpeaking = false; // Marcar como no reproduciendo
        playChunks(); // Reproducir el siguiente grupo de chunks si existe
    };
}





const startRecording = async () => {
    setIsRecording(true);
   
    audioChunksRef.current = [];
    audioContext.current = new (window.AudioContext || window.webkitAudioContext)();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.start();

      mediaRecorder.onstart = () => {
       setMessages((prev) => [...prev,{ role: 'system', text: 'Recording started...' },]);
      };

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if(!muteMic.current){
          setMessages((prev) => [...prev,{ role: 'system', text: 'Processing audio...' },]);
          processAudio();
        }
      };

      /* Init context to create the voice detection funcionality */
      let audioContext2 = new AudioContext();
      analyser.current = audioContext2.createAnalyser();
      const source = audioContext2.createMediaStreamSource(stream);
      source.connect(analyser.current);

      /* Call to silent detection function */
      detectSpeech();

    } catch (error) {
      setIsRecording(false);
      setMessages((prev) => [ ...prev, { role: 'system', text: 'Microphone access denied or unavailable.' },]);
    }
  };


  


 async function detectSpeech() {
  let stopRecord = false;

  // Obtener y normalizar los datos de frecuencia.
  const dataArray = new Uint8Array(analyser.current.frequencyBinCount);
  analyser.current.getByteFrequencyData(dataArray);

  const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
  const normalizedVolume = average / 255;
  const now = Date.now();
  // Suavizado exponencial
  volumeLevel.current = SMOOTHING_FACTOR * volumeLevel.current + (1 - SMOOTHING_FACTOR) * normalizedVolume;
  console.log(SENSITIVITY * NOISE_THRESHOLD, volumeLevel.current)
  // Comprobación de nivel de volumen
  if (volumeLevel.current > SENSITIVITY*NOISE_THRESHOLD) {
    isSpeaking.current = true;
    silenceStartTime.current = null;
  } else {
    if (isSpeaking.current) {
      if (!silenceStartTime.current) silenceStartTime.current = now;
      if (now - silenceStartTime.current > SILENCE_TIMEOUT) {
        isSpeaking.current = false;
        stopRecord = true
        
      }
    }
  }

  // Detener o continuar la detección
  stopRecord ? stopRecording() : (animationFrameId.current = requestAnimationFrame(detectSpeech));
}
  /**
   * Stops the ongoing audio recording.
   */
  const stopRecording = () => {
    setIsRecording(false);
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
    }
    if(animationFrameId.current){
      cancelAnimationFrame(animationFrameId.current)
    }
    
  };

  /**
   * Processes the recorded audio, encodes it to PCM16 mono 24kHz, and sends it to the backend server.
   */
  const processAudio = async () => {

    try {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
      if (blob.size == 0) throw 'No audio'
      const processedBase64Audio = await convertBlobToPCM16Mono24kHz(blob);
  
      if (!processedBase64Audio) {
        setMessages((prev) => [ ...prev, { role: 'system', text: 'Failed to process audio.' }]);
        return;
      }
  
      wsRef.current.emit('sendMessage',{"audio": processedBase64Audio});
      setMessages((prev) => [ ...prev, { role: 'system', text: 'Audio sent to assistant for processing.' }]);

    } catch (error) {
      stopRecording()
      startRecording()
    }
   
  };



  //  ############  Utility  #############   //
  const convertBlobToPCM16Mono24kHz = async (blob) => {
    try {
      // Initialize AudioContext with target sample rate
      console.log(blob)
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

  const muteMicrophone = () => {
    muteMic.current = true
    stopRecording()
  }

  const unmuteMicrophone = () => {
    muteMic.current = false
    startRecording()
  }


  const connect_to_server = () =>{
  
    const socket = io('url', {
      query: {
        token: 'token'
      },
      transports: ['websocket'],
      reconnection: false, 
    });

    socket.on('connect', () => {
      console.log('Connected to backend WebSocket');
      setMessages((prev) => [...prev,{ role: 'system', text: 'Connected to assistant.' },]);

    });

    socket.on('responseMessage',  (event) => {
      try {
        processServerMessage(event)
      } catch (error) {
        console.error('Error handling incoming message:', error);
      }
    });

    socket.on('disconnect', () => {
      setMessages((prev) => [...prev,{ role: 'system', text: 'Disconnected from assistant.' },]);
    });
   
    wsRef.current = socket;
  }

  return (
    <div className="App">
      <h1>OpenAI Realtime API Demo</h1>
      <button onClick={connect_to_server}>Connect Server</button>
      <button onClick={isRecording ? muteMicrophone : unmuteMicrophone}>
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