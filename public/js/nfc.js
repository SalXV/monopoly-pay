/**
 * Supporto Web NFC (Android Chrome) per Tap-to-Pay / Ricevi tramite NFC.
 */

export function isWebNfcSupported() {
  return 'NDEFReader' in window;
}

export async function readNfcPaymentTag(onPayload, onStatus) {
  if (!isWebNfcSupported()) {
    onStatus('Web NFC disponibile solo su Android Chrome. Su iOS usa il QR Code dinamico o la selezione rapida.');
    return null;
  }
  try {
    const ndef = new window.NDEFReader();
    const controller = new AbortController();
    await ndef.scan({ signal: controller.signal });
    onStatus('Avvicina lo smartphone o il tag NFC per pagare...');

    ndef.onreading = (event) => {
      for (const record of event.message.records) {
        try {
          const decoder = new TextDecoder(record.encoding || 'utf-8');
          const text = decoder.decode(record.data);
          onPayload(text);
        } catch (_) {}
      }
    };
    return () => controller.abort();
  } catch (err) {
    onStatus(`NFC non avviato: ${err.message}`);
    return null;
  }
}

export async function writeNfcPaymentTag(payload, onStatus) {
  if (!isWebNfcSupported()) {
    onStatus('Web NFC disponibile solo su Android Chrome.');
    return false;
  }
  try {
    const ndef = new window.NDEFReader();
    await ndef.write({
      records: [{ recordType: 'text', data: payload }],
    });
    onStatus('Tag NFC scritto con i tuoi dati Monopoly Pay!');
    return true;
  } catch (err) {
    onStatus(`Scrittura NFC fallita: ${err.message}`);
    return false;
  }
}
