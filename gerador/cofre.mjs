// Cofre dos segredos do GitHub Actions: token Microsoft, senha do painel, sal e fixos.json
// vão juntos num arquivo cifrado (segredos.enc, AES-256-GCM) que fica no repositório.
// A chave (32 bytes aleatórios, base64) existe só no segredo CHAVE_CI do GitHub e no
// arquivo .chave-ci deste PC — nunca no repositório.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const chave = (b64) => {
  const k = Buffer.from(String(b64 || '').trim(), 'base64');
  if (k.length !== 32) throw new Error('CHAVE_CI ausente ou inválida');
  return k;
};
export function cifrar(obj, chaveB64) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave(chaveB64), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), ct: ct.toString('base64') });
}
export function decifrar(texto, chaveB64) {
  const { iv, ct } = JSON.parse(texto);
  const buf = Buffer.from(ct, 'base64');
  const d = createDecipheriv('aes-256-gcm', chave(chaveB64), Buffer.from(iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
}
