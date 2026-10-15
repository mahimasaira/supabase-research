// npm run hosted:lockdown: runs sql/lockdown.sql on the HOSTED database (never the local one).
import { psql } from './hosted-env.mjs'

console.log(psql(null, { file: 'src/probes/hosted/sql/lockdown.sql' }))
console.log('\nDone. Next: npm run hosted:preflight')
