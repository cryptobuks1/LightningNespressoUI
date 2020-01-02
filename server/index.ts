import express from 'express'
import expressWs from 'express-ws'
import cors from 'cors'
import bodyParser from 'body-parser'
import {Invoice, GetInfoResponse} from '@radar/lnrpc'
import {randomBytes} from 'crypto'
import env from './env'
import {node, initNode} from './node'
const globalAny: any = global
globalAny.fetch = require('node-fetch')
const cc = require('cryptocompare')
let wsConnections = []
let retryCreateInvoiceStreamCount = 1
let retryInit = 1
let retryDelivery = 1

// Configure server
const wsInstance = expressWs(express(), undefined, {wsOptions: {clientTracking: true}})
const app = wsInstance.app
app.use(cors({origin: '*'}))
app.use(bodyParser.json())


// Websocket route
app.ws('/api/ws', (ws) => {
  const wsClientId: string = randomBytes(2).toString('hex')
  console.log(`New websocket connection open by client ${wsClientId}`)

  // Send this key to client
  ws.send(JSON.stringify({
    data: wsClientId,
    type: 'client-id'
  }))

  const pingInterval = setInterval(() => ws.ping(
    "heartbeat",
    false
  ), 10000)

  ws.on('pong', function heartbeat(pingData) {
    if (pingData.toString() !== 'heartbeat') {
      console.log('Websocket pong not received')
    }
  })

  ws.addEventListener('error', (ErrorEvent) => {
    console.log('Websocket error', ErrorEvent.error)
  })

  ws.addEventListener('close', (e) => {
    if (e.wasClean) {
      console.log(`Connection websocket ${wsClientId} closed normally`)
    } else {
      console.log(`Connection websocket ${wsClientId} closed abnormally`)
      console.log('Close code', e.code)
    }
    console.log(`Stop pinging client ${wsClientId}`)
    clearInterval(pingInterval)

    // Remove closed ws
    wsConnections = wsConnections.filter(function(wsConnection){
      // Check if wsConnection is the one wsClientId is closing, return all the others
      return Object.keys(wsConnection)[0] !== wsClientId
    })
  })

  // Store client connection
  wsConnections.push({[wsClientId]: ws})
  console.log(`There ${wsConnections.length === 1 ? 'is' : 'are'} ${wsConnections.length} websocket ` +
    `connection${wsConnections.length === 1 ? '' : 's'} currently`)
})

app.post('/api/generatePaymentRequest', async (req, res, next) => {
  try {
    const {memo, value} = req.body

    if (!memo || !value) {
      throw new Error('Fields "memo" and "value" are required to create an invoice')
    }

    const invoice = await node.addInvoice({
      memo: memo,
      value: env.TESTING === 'true' ? '1' : value,
      expiry: '300', // 5 minutes
    })

    res.json({
      data: {
        paymentRequest: invoice.paymentRequest,
      },
    })
  } catch (err) {
    next(err)
  }
})

app.get('/api/getPrice', async (req, res, next) => {
  try {
    // CryptoCompare API
    cc.price('BTC', ['USD', 'EUR'])
      .then(prices => {
        return res.json({data: prices})
      })
      .catch(console.error)
  } catch (err) {
    next(err)
  }
})

app.get('/api/getNodeInfo', async (req, res, next) => {
  let retryCount = 1
  ;(async function getInfoFn() {
    try {
      const info = await node.getInfo()
      res.json({data: info})
    } catch (err) {
      console.log('Get node info error: ', err.message)
      console.log(`#${retryCount} - call getInfo again after ${500 * Math.pow(2, retryCount)}`)
      const getInfoTimeout = setTimeout(getInfoFn, 500 * Math.pow(2, retryCount))
      if (retryCount === 15) {
        console.log('Give up call getInfo')
        clearTimeout(getInfoTimeout)
        next(err)
      }
      retryCount++
    }
  })()
})

app.get('/', (req, res) => {
  res.send('You need to load the webpack-dev-server page, not the server page!')
})


// Push invoice to client
const notifyClientPaidInvoice = function (invoice, wsClientIdFromInvoice) {
  wsConnections.forEach((connection) => {
    const id = Object.keys(connection)[0]

    if (wsClientIdFromInvoice === id) {
      console.log('Notify client', id)
      console.log('Websocket readyState', connection[id].readyState)
      connection[id].send(
        JSON.stringify({
          type: 'invoice-settlement',
          data: invoice,
        }), (error) => {
          if (error) {
            console.log(`Error when sending "invoice-settlement" to client ${id}`, error)
          }
        })
    }
  })
}

const notifyClientDeliveryFailure = function (error, wsClientIdFromInvoice) {
  wsConnections.forEach((connection) => {
    const id = Object.keys(connection)[0]

    if (wsClientIdFromInvoice === id) {
      console.log('Notify client delivery failure', id)
      console.log('Websocket readyState', connection[id].readyState)
      connection[id].send(
        JSON.stringify({
          type: 'delivery-failure',
          data: error.message,
        }), (error) => {
          if (error) {
            console.log(`Error notify delivery failure to client ${id}`, error)
          }
        })
    }
  })
}

// Call ESP8266 - Deliver coffee
const deliverCoffee = function (invoice, wsClientIdFromInvoice) {
  return new Promise((resolve, reject) => {
    let id = invoice.memo.charAt(1)
    console.log(`Deliver coffee on rail ${id}`)
    const body = { coffee: id as string};
    globalAny.fetch(env.VENDING_MACHINE, {
      method: 'post',
      body:    JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
      .then(response => {
        if(response.ok){
          console.log('Request to vending machine sent')
        }else{
          throw new Error(response.statusText)
        }
      })
      .then(() => {
        // Reset counter
        retryDelivery = 1
        resolve()
      })
      .catch((error) => {
        console.log('Coffee delivering error', error)
        console.log(`#${retryDelivery} - Try delivery again after ${200 * Math.pow(2, retryDelivery)}ms ...`)
        const deliveryTimeout = setTimeout(() => deliverCoffee(invoice, wsClientIdFromInvoice), 200 * Math.pow(2, retryDelivery))
        if (retryDelivery === 3) {
          console.log('Give up delivery')
          clearTimeout(deliveryTimeout)
          reject(new Error ('Sorry, your coffee delivery has failed.'))
        }
        retryDelivery++
      })
  })
    .catch((error) => {
      console.log(error)
      notifyClientDeliveryFailure(error, wsClientIdFromInvoice)
      retryDelivery = 1
    })
}

const retryCreateInvoiceStream = async function(error: Error) {
  console.log('Try opening stream again')
  let msDelay = 500 * Math.pow(2, retryCreateInvoiceStreamCount)
  console.log(`#${retryCreateInvoiceStreamCount} - call createLndInvoiceStream again after ${msDelay}`)
  const openLndInvoicesStreamTimeout = setTimeout(async () => {
    await createLndInvoiceStream()
    const nodeInfo = await checkLnd()
    if (nodeInfo instanceof Error) {
      retryCreateInvoiceStreamCount++
      console.log('increment retryCreateInvoiceStreamCount', retryCreateInvoiceStreamCount)
    } else {
      console.log('Reset counter retryCreateInvoiceStreamCount')
      retryCreateInvoiceStreamCount = 1
    }
  }, msDelay)

  if (retryCreateInvoiceStreamCount === 15) {
    console.log('Give up call createLndInvoiceStream')
    clearTimeout(openLndInvoicesStreamTimeout)
    throw error
  }
}

const createLndInvoiceStream = async function() {
  console.log('Opening LND invoice stream...')
  // SubscribeInvoices returns a uni-directional stream (server -> client) for notifying the client of newly added/settled invoices
  let lndInvoicesStream = await node.subscribeInvoices()
  lndInvoicesStream
    .on('data', async (invoice: Invoice) => {
      // Skip unpaid / irrelevant invoice updates
      // Memo should start with '#'
      if (!invoice.settled || !invoice.amtPaidSat || !invoice.memo || invoice.memo.charAt(0) !== '#') return

      // Handle Invoice Settlement
      console.log(`Invoice settled - ${invoice.memo}`)
      const wsClientIdFromInvoice = invoice.memo.substr(invoice.memo.indexOf('@') + 1, 4)
      deliverCoffee(invoice, wsClientIdFromInvoice)
        .then(() => {
          notifyClientPaidInvoice(invoice, wsClientIdFromInvoice)
        })
    })
    .on('status', (status) => {
      console.log(`SubscribeInvoices status: ${JSON.stringify(status)}`)
      // https://github.com/grpc/grpc/blob/master/doc/statuscodes.md
    })
    .on('error', async (error) => {
      console.log(`SubscribeInvoices error: ${error}`)
      await retryCreateInvoiceStream(error)
    })
    .on('end', async () => {
      console.log('Stream end event. No more data to be consumed from lndInvoicesStream')
      await retryCreateInvoiceStream(new Error('Impossible to open LND invoice stream'))
    })
}

// Check connection to LND instance or invoice stream
const checkLnd = async function() {
  console.log('Check connection to LND instance...')
  // We check by calling getInfo()
  try {
    const info: GetInfoResponse = await node.getInfo()
    return info
  } catch (err) {
    return err
  }
}

// General server initialization
const init = function () {
  console.log('Connecting to LND instance...')
  initNode()
    .then(async () => {
      const nodeInfo = await checkLnd()

      if (nodeInfo instanceof Error) {
        throw nodeInfo
      } else {
        console.log('Node info ', nodeInfo)
        console.log('Connected to LND instance!')
        console.log('LND invoice stream opened successfully')
      }

      await createLndInvoiceStream()

      console.log('Starting server...')
      await app.listen(env.SERVER_PORT, () => console.log(`API Server started at http://localhost:${env.SERVER_PORT}!`))
    })
    .then(() => {
      // Reset counter
      retryInit = 1
    })
    .then(() => {
      // Ping LND to keep stream open
      setInterval(checkLnd, (1000 * 60 * 9))
    })
    .catch((err) => {
      console.log('Server initialization failed ', err)
      console.log('Try server initialization again...')
      console.log(`#${retryInit} - call init() again after ${500 * Math.pow(2, retryInit)}`)
      const initTimeout = setTimeout(init, 500 * Math.pow(2, retryInit))
      if (retryInit === 15) {
        console.log('Give up server initialization')
        clearTimeout(initTimeout)
      }
      retryInit++
    })
}
init()