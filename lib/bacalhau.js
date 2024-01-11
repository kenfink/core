import timers from 'node:timers/promises'
import { execa } from 'execa'
import { fetch } from 'undici'
import Sentry from '@sentry/node'
import { installBinaryModule, getBinaryModuleExecutable } from './modules.js'
import os from 'node:os'
import { once } from 'node:events'

const DIST_TAG = 'v1.0.3'
const { TARGET_ARCH = os.arch() } = process.env

export async function install () {
  await installBinaryModule({
    module: 'bacalhau',
    repo: 'bacalhau-project/bacalhau',
    executable: 'bacalhau',
    distTag: DIST_TAG,
    arch: TARGET_ARCH,
    targets: [
      { platform: 'darwin', arch: 'x64', asset: `bacalhau_${DIST_TAG}_darwin_amd64.tar.gz` },
      { platform: 'darwin', arch: 'arm64', asset: `bacalhau_${DIST_TAG}_darwin_arm64.tar.gz` },
      { platform: 'linux', arch: 'x64', asset: `bacalhau_${DIST_TAG}_linux_amd64.tar.gz` },
      { platform: 'linux', arch: 'arm64', asset: `bacalhau_${DIST_TAG}_linux_arm64.tar.gz` },
      { platform: 'linux', arch: 'aarch64', asset: `bacalhau_${DIST_TAG}_linux_arm64.tar.gz` },
      { platform: 'win32', arch: 'x64', asset: `bacalhau_${DIST_TAG}_windows_amd64.tar.gz` }
    ]
  })
}

const getApiUrl = childProcess => new Promise((resolve, reject) => {
  let output = ''

  const readyHandler = data => {
    output += data.toString()

    const apiMatch = output.match(/^API: (http.*)$/m)
    if (apiMatch) {
      childProcess.stdout.off('data', readyHandler)
      const apiUrl = apiMatch[1]
      resolve(apiUrl)
    }
  }
  childProcess.stdout.on('data', readyHandler)
  childProcess.catch(reject)
})

const runMetricsLoop = async ({ childProcess, apiUrl, onMetrics }) => {
  while (true) {
    if (
      childProcess.exitCode !== null ||
      childProcess.signalCode !== null
    ) {
      break
    }
    try {
      await updateStats({ apiUrl, onMetrics })
    } catch (err) {
      const errString = err.stack || err.message || err
      console.error(`Cannot fetch Bacalhau module stats. ${errString}`)
    }
    await timers.setTimeout(1000)
  }
}

export async function run ({
  FIL_WALLET_ADDRESS,
  storagePath,
  onActivity,
  onMetrics
}) {
  const childProcess = execa(
    getBinaryModuleExecutable({
      module: 'bacalhau',
      executable: 'bacalhau'
    }),
    [
      'serve',
      '--log-mode=station',
      '--node-type=compute',
      // Connect to the public network
      '--peer=env',
      '--private-internal-ipfs=false',
      // Limit resources
      '--limit-total-cpu=1',
      '--limit-total-gpu=0',
      '--limit-total-memory=200Mb',
      '--disable-engine=docker'
    ],
    {
      env: {
        FIL_WALLET_ADDRESS,
        ROOT_DIR: storagePath
      }
    }
  )

  childProcess.stdout.setEncoding('utf-8')
  childProcess.stdout.on('data', data => {
    if (data.includes('/compute/debug') && data.includes(200)) {
      // Ignore noisy lines
      return
    }
    handleActivityLogs({ onActivity, text: data })
  })
  childProcess.stderr.pipe(process.stderr, { end: false })

  childProcess.on('exit', (code, signal) => {
    const reason = signal ? `via signal ${signal}` : `with code: ${code}`
    const msg = `Bacalhau exited ${reason}`
    onActivity({ type: 'info', message: msg })
  })

  await Promise.all([
    (async () => {
      let apiUrl
      try {
        apiUrl = await getApiUrl(childProcess)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : '' + err
        const message = `Cannot start Bacalhau: ${errorMsg}`
        onActivity({ type: 'error', message })
        throw err
      }

      onActivity({ type: 'info', message: 'Bacalhau module started.' })
      await runMetricsLoop({ childProcess, apiUrl, onMetrics })
    })(),
    (async () => {
      const [code] = await once(childProcess, 'close')
      console.error(`Bacalhau closed all stdio with code ${code ?? '<no code>'}`)
      childProcess.stderr.removeAllListeners()
      childProcess.stdout.removeAllListeners()
      Sentry.captureException('Bacalhau exited')
      throw new Error('Bacalhau exited')
    })()
  ])
}

function handleActivityLogs ({ onActivity, text }) {
  text
    .trimEnd()
    .split(/\n/g)
    .forEach(line => {
      const m = line.match(/^(INFO|ERROR): (.*)$/)
      if (m) {
        onActivity({ type: m[1].toLowerCase(), message: m[2] })
      }
    })
}

/** @typedef {{
 *   jobsCompleted: number
 * }?} BacalhauStats */

async function updateStats ({ apiUrl, onMetrics }) {
  const res = await fetch(apiUrl)
  if (!res.ok) {
    const msg = 'Cannot fetch Bacalhau stats: ' +
      `${res.status}\n${await res.text().catch(noop)}`
    throw new Error(msg)
  }

  const stats = /** @type {BacalhauStats} */ (await res.json())

  const totalJobsCompleted = stats?.jobsCompleted
  if (typeof totalJobsCompleted !== 'number') {
    const msg = 'Unexpected stats response - jobsCompleted is not a ' +
      'number. Is: ' + JSON.stringify(stats)
    throw new Error(msg)
  }
  onMetrics({ totalJobsCompleted, rewardsScheduledForAddress: '0' })
}

function noop () {
  // no-op
}
