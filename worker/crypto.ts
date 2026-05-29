export async function encrypt(text: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const keyBuf = enc.encode(secret.padEnd(32, '0')).slice(0, 32);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    'AES-GCM',
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(text)
  );

  // Combine IV and encrypted data
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  // Convert to Base64
  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(data: string, secret: string): Promise<string> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const keyBuf = enc.encode(secret.padEnd(32, '0')).slice(0, 32);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    'AES-GCM',
    false,
    ['decrypt']
  );

  // Decode Base64
  const binary = atob(data);
  const combined = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    combined[i] = binary.charCodeAt(i);
  }

  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ct
  );

  return dec.decode(decrypted);
}
