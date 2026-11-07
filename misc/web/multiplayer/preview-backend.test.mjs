import test from 'node:test';import assert from 'node:assert/strict';
import {backendUrl,localRequestAllowed,backendHeaders,backendPath} from './preview-backend.mjs';
test('remote preview credentials require HTTPS and never accept a foreign origin or Host',()=>{
 assert.throws(()=>backendUrl('http://example.com'));assert.throws(()=>backendUrl('https://u:p@example.com'));assert.throws(()=>backendUrl('https://example.com/path'));
 const backend=backendUrl('https://test.fly.dev');assert.equal(backendHeaders({host:'localhost:8089',origin:'http://localhost:8089'},backend,'fixture').authorization,'Bearer fixture');
 assert.equal(backendHeaders({},backend,'fixture').origin,'https://test.fly.dev');
 assert.ok(localRequestAllowed({host:'localhost:8089',origin:'http://localhost:8089'},8089));
 assert.ok(localRequestAllowed({host:'127.0.0.1:8089'},8089));
 assert.ok(!localRequestAllowed({host:'attacker.example:8089'},8089));
 assert.ok(!localRequestAllowed({host:'localhost:8089',origin:'https://attacker.example'},8089));
 assert.equal(backendUrl('http://127.0.0.1:8087').port,'8087');
});
test('identity pagination cursor and generation reach the upstream unchanged',()=>{
 assert.equal(backendPath('/identity/entities?after=abc&generation=2'),'/identity/entities?after=abc&generation=2');
});
