/* Run with the pinned Zotero document-worker source checkout and its installed
   dependencies. This optional preparation tool never edits the input PDF. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [workerRoot,source,output]=process.argv.slice(2);
if(!workerRoot||!source||!output)throw Error('worker-root source.pdf output-directory required');
const root=path.resolve(workerRoot),load=p=>import(pathToFileURL(path.join(root,p)).href);
const {getStructure}=await load('src/pdf/index.js');
const {packStructuredDocumentText}=await load('structured-document-text/src/pack/writer.js');
const {deflateSync}=await load('node_modules/fflate/esm/index.mjs');
const bytes=fs.readFileSync(source),sourceHash=crypto.createHash('md5').update(bytes).digest('hex');
const structure=await getStructure(bytes,'',p=>fs.readFileSync(path.join(root,'build',p)),{sourceHash,onProgress:p=>process.stderr.write('progress '+p+'\n')});
fs.writeFileSync(path.join(output,'structure.json'),JSON.stringify(structure));
const pack=packStructuredDocumentText(structure,{destructive:true,deflate:b=>deflateSync(b)});
fs.writeFileSync(path.join(output,'document.sdt'),new Uint8Array(pack));
fs.copyFileSync(path.join(root,'build/metadata.json'),path.join(output,'worker-metadata.json'));
process.stdout.write(JSON.stringify({source_md5:sourceHash})+'\n');
