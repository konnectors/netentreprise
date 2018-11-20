process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://32708485f2c0401294c9ccc50077e15d@sentry.cozycloud.cc/97'

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  log,
  saveBills
} = require('cozy-konnector-libs')
const moment = require('moment')
const pdf = require('pdfjs')
const fs = require('fs')

const request = requestFactory({
  debug: false,
  cheerio: true,
  json: false,
  jar: true,
  encoding: 'latin1'
})

const baseUrl = 'https://net-entreprise.fr/'
const serviceUrl = 'https://portail.net-entreprises.fr/priv/'
const urssafUrl = 'https://www.ti.urssaf.fr/'
module.exports = new BaseKonnector(start)

/* Startup Function for the konnector */
async function start(fields) {
  log('info', 'Authenticating ...')
  //Auth and retrieve declaration URL
  const urlDeclaration = await authenticate(
    fields.siret,
    fields.lastname,
    fields.firstname,
    fields.password
  )
  log('info', 'Successfully logged in')

  log('info', 'Get Declarations Parameters')
  let params = await getDeclarationsParameters(urlDeclaration)
  log('info', 'Get Declarations')
  const declarationList = await buildDeclarationList(params)
  const getAllDec = getAllDeclaration.bind(this)
  const bills = await getAllDec(params, declarationList)

  await saveBills(bills, fields, {
    identifiers: ['net-entreprise'],
    contentType: 'application/pdf'
  })
}

/* Handle Authentication */
async function authenticate(siret, lastname, firstname, password) {
  const response = await signin({
    url: `${baseUrl}`,
    formSelector: 'form#form__connect',
    formData: {
      j_siret: siret,
      j_nom: lastname,
      j_prenom: firstname,
      j_password: password
    },
    // the validate function will check if
    validate: (statusCode, body, fullResponse) => {
      if (fullResponse.request['uri']['pathname'].startsWith('/auth/erreur'))
        return false
      else if (
        fullResponse.request['uri']['pathname'].startsWith('/priv/declarations')
      ) {
        return true
      } else {
        return false
      }
    },
    json: false,
    headers: {
      Referer: 'https://www.net-entreprises.fr/',
      'Upgrade-Insecure-Requests': '1'
    }
  })

  //Extract url for access to declarations
  const doc = scrape(response('#service-10'), {
    url: {
      attr: 'href',
      parse: href => `${serviceUrl}${href}`
    }
  })

  return doc.url
}

/* Get All Parameters for declarations */
async function getDeclarationsParameters(url) {
  let response = await request(url)
  let doc = scrape(response('[name="form"]'), {
    url: {
      attr: 'action'
    },
    name: {
      sel: 'input',
      attr: 'name'
    },
    value: {
      sel: 'input',
      attr: 'value'
    }
  })

  response = await request({
    method: 'POST',
    uri: doc.url,
    form: { [doc.name]: doc.value }
  })

  doc = response('[name="menuform"]').serializeArray()
  let form = {}
  for (let i = 0; i < doc.length; i++) {
    form[[doc[i].name]] = doc[i].value
  }
  return form
}

/* Get all available declarations IDs */
async function buildDeclarationList(params) {
  params.codepaye = 10
  params.echeance = 44
  params.listexi = ''
  params.habpai = 'N'
  params.habdev = 'N'
  let completeList = []
  let partialList = await getList(params, '/action.encours_netmicro', 'href', 1)
  for (let i = 1; i < partialList.length; i++)
    completeList.push(parseInt(partialList[i].period))
  partialList = await getList(params, '/action.histo_netmicro', 'onclick', 0)
  for (let i = 0; i < partialList.length; i++)
    completeList.push(parseInt(partialList[i].period))
  return completeList
}

/* Extract IDs from menu */
async function getList(params, urlPart, subItem, splitPart) {
  const data = await request({
    method: 'POST',
    uri: `${urssafUrl}/${urlPart}`,
    form: params
  })
  let doc = scrape(
    data,
    {
      period: {
        sel: 'a',
        attr: subItem,
        parse: href => href.split("('")[1].split("','")[splitPart]
      }
    },
    '.menu_microsocial .subitem_menu_microsocial'
  )
  return doc
}

/* Function that retrieve all new declaration not sync before */
async function getAllDeclaration(params, declarationList) {
  let accData = this.getAccountData()
  let exist = Object.keys(accData).length > 0
  let bills = []
  let lastPeriod = declarationList.length - 1
  if (exist) {
    let lastSaved = declarationList.indexOf(accData.lastSaved)
    if (lastSaved !== -1) lastPeriod = lastSaved
  }
  for (let i = lastPeriod; i >= 0; i--) {
    try {
      const bill = await getDeclaration(params, declarationList[i])
      bills.push(bill)
      accData.lastSaved = declarationList[i]
      this.saveAccountData(accData, { merge: false })
    } catch (error) {
      log('error', error)
      break
    }
  }
  return bills
}

/* Get a specific declaration */
async function getDeclaration(params, periode) {
  params.periode = periode
  params.codepaye = 10
  params.echeance = 44
  params.listexi = ''
  params.habpai = 'N'
  params.habdev = 'N'
  const data = await request({
    method: 'POST',
    uri: `${urssafUrl}/action.histo_netmicro`,
    form: params
  })
  let subData = scrape(data('#table-paiements-tldp .cellule_droite_middle'), {
    amount: {
      sel: 'span#libmtpai',
      parse: value => {
        value = value.replace('.', '')
        return parseInt(value)
      }
    }
  })
  let bill = {}
  bill.amount = subData.amount
  subData = scrape(
    data,
    {
      date: {
        sel: 'span.text_grand_gras'
      }
    },
    '.tableau_donnees .cellule_droite_middle'
  )
  subData = subData[2].date
    .substring(3)
    .substring(0, 10)
    .trim()
  moment.locale('fr')
  subData = subData.split('/')
  let day = parseInt(subData[0])
  day = day < 10 ? '0' + day.toString() : day.toString()
  bill.date = moment(
    '' + subData[2] + '-' + subData[1] + '-' + day + 'T00:00:00.000Z'
  )
    .add(1, 'days')
    .toDate()
  bill.vendor = 'urssaf'
  let month = periode % 100
  if (month % 10 == 0) {
    month = month / 10
  } else {
    let tri = Math.floor(month / 10)
    month = month % 10
    month = (tri - 1) * 3 + month
    if (month < 10) month = '0' + month
  }
  let year = 2000 + Math.floor(periode / 100)
  bill.filename = '' + year + '-' + month + '.pdf'
  bill.filestream = await buildDeclarationPDF(data, periode)
  return bill
}

/* Build PDF from declaration */
async function buildDeclarationPDF(data, periode) {
  var doc = new pdf.Document()

  doc.text('Généré par le connceteur Net-Entreprise (Micro-Entrepreneur)', {
    font: require('pdfjs/font/Helvetica-Bold'),
    fontSize: 9
  })
  //title
  let table = doc.table({ widths: [140, 400], borderWidth: 0 })
  const img = new pdf.Image(fs.readFileSync('img.jpg'))
  let row = table.row()
  row.cell({ paddingTop: 0.5 * pdf.cm, paddingBottom: 0.5 * pdf.cm }).image(img)
  let cell = row
    .cell({
      paddingTop: 0.5 * pdf.cm,
      paddingBottom: 0.5 * pdf.cm,
      paddingLeft: 0.2 * pdf.cm
    })
    .text()
  let type = 'Déclaration Trimestrielle de Recettes'
  if (periode % 10 !== 0) type = 'Déclaration Mensuelle de Recettes'
  type += '\n Régime micro-social simplifié'
  cell.add(type, {
    font: require('pdfjs/font/Helvetica-Bold'),
    fontSize: 14
  })

  doc.cell({ paddingBottom: 1.0 * pdf.cm }).text()

  //first table
  let tableau = data('.tableau_donnees')
  table = doc.table({
    widths: [270, 270],
    borderWidth: 1
  })
  let element = data(tableau[0]).children('tbody')
  let subData = element.children('tr')
  let optsLeft = { backgroundColor: '#A0A0A0' }
  subData.each((i, elem) => {
    elem = data(elem).children('td')
    let value = data(elem[0])
      .text()
      .trim()
    let row = table.row({ padding: 0.1 * pdf.cm })
    row.cell(value, optsLeft)
    value = data(elem[1])
      .find('span')
      .text()
      .trim()
      .replace(/\s\s+/g, ' ')
    row.cell(value)
  })

  doc.cell({ paddingBottom: 2.0 * pdf.cm }).text()

  //second table
  table = doc.table({
    widths: [400, 60, 80],
    borderWidth: 1
  })
  element = data(tableau[1]).children('tbody')
  subData = element.children('tr')

  //parse table
  subData.each((i, elem) => {
    const savedElem = elem
    elem = data(elem).children('td')

    let optsRight = { alignment: 'right' }
    let optsCenter = { alignment: 'center' }

    let key = data(elem[0])
      .text()
      .trim()
    //subtable
    if (data(elem).find('table').length > 1) {
      if (data(elem).find('td#lib_cotisations').length > 0) {
        elem = data(savedElem).find('td#lib_cotisations')
        //2 tab
        let title = data(elem[0])
          .find('b')
          .text()
        let row = table.row({ padding: 0.1 * pdf.cm })
        let cell = row.cell(title, optsLeft)
        let subTable = cell.table({
          widths: [340, 50],
          borderWidth: 0,
          paddingLeft: 0.2 * pdf.cm,
          paddingBottom: 0.1 * pdf.cm
        })
        let subElem = data(elem[0]).find('tr')
        for (let j = 0; j < subElem.length; j++) {
          let subRow = subTable.row()
          const td = data(subElem[j]).find('td')
          subRow.cell(
            data(td[0])
              .text()
              .trim()
          )
          subRow.cell(
            data(td[1])
              .text()
              .trim()
          )
        }
        let subRow = subTable.row()
        subRow.cell('.', { color: '#A0A0A0' })
        subRow.cell('.', { color: '#A0A0A0' })

        subElem = data(elem[1]).find('tr')
        for (let k = 1; k <= 2; k++) {
          let cell = row.cell('.', { alignment: 'center', color: '#FFFFFF' })
          subTable = cell.table({
            widths: [55 + 18 * (k - 1)],
            borderWidth: 0,
            paddingBottom: 0.1 * pdf.cm,
            color: '#000000'
          })
          for (let j = 0; j < subElem.length; j++) {
            let subRow = subTable.row()
            const td = data(subElem[j]).find('td')
            optsRight.alignment = 'right'
            delete optsRight.color
            if (k === 1) optsRight.alignment = 'center'
            let text = data(td[k])
              .text()
              .trim()
            if (text.length === 0) {
              optsRight.color = '#FFFFFF'
              text = '.'
            }
            subRow.cell(text, optsRight)
          }
        }
      } else if (data(elem).find('table#table-paiements-tldp').length > 0) {
        //sepa
        elem = data(elem).find('table#table-paiements-tldp')
        elem = data(elem)
          .children('tbody')
          .children('tr')
        for (let j = 0; j < elem.length - 1; j++) {
          let subElem = data(elem[j]).find('.cellule_gauche_top tr')
          let title = data(subElem)
            .find('strong')
            .text()
            .trim()
          let row = table.row({ padding: 0.1 * pdf.cm })

          let cell = row.cell(title, optsLeft)
          let subTable = cell.table({
            widths: [130, 260],
            borderWidth: 0,
            paddingLeft: 0.2 * pdf.cm
          })
          let subRow = subTable.row()
          let bic = data(subElem)
            .find('div')
            .text()
            .trim()
          subRow.cell(bic, optsLeft)
          let full = data(subElem)
            .find('.cellule_defaut')
            .text()
            .trim()
          let half = data(subElem)
            .find('.cellule_defaut')
            .children()
            .text()
            .trim()
          subRow.cell(full.substring(half.length), optsLeft)

          subElem = data(elem[j])
            .find('.cellule_droite_top tr')
            .children()
          title = data(subElem[1])
            .text()
            .trim()
          optsCenter.color = '#FFFFFF'
          cell = row.cell('.', optsCenter)
          delete optsCenter.color
          subTable = cell.table({ widths: [55], borderWidth: 0 })
          subRow = subTable.row()
          subRow.cell(title, optsCenter)
          title = data(subElem[2])
            .text()
            .trim()
          optsRight.color = '#FFFFFF'
          cell = row.cell('.', optsRight)
          delete optsRight.color
          subTable = cell.table({ widths: [73], borderWidth: 0 })
          subRow = subTable.row()
          subRow.cell(title, optsRight)
        }
        let subElem = data(elem[elem.length - 1]).find('.cellule_gauche_middle')
        let row = table.row({ padding: 0.1 * pdf.cm })
        row.cell(
          data(subElem)
            .text()
            .trim(),
          optsLeft
        )
        subElem = data(elem[elem.length - 1]).find(
          '.cellule_droite_middle .cellule_defaut'
        )
        row.cell(
          data(subElem[1])
            .text()
            .trim(),
          optsCenter
        )
        row.cell(
          data(subElem[2])
            .text()
            .trim(),
          optsRight
        )
      }
      return true
    }
    if (key !== '') {
      let subElem = data(elem[1])
        .find('span')
        .parent()
      let value = ''
      let interValue = ''
      let factor = 0.1
      //has 2 col value
      if (subElem.length > 1) {
        value = data(subElem[1])
          .text()
          .trim()
          .replace(/\s\s+/g, ' ')
        interValue = data(subElem[0])
          .text()
          .trim()
          .replace(/\s\s+/g, ' ')
      } else {
        value = data(subElem[0])
          .text()
          .trim()
          .replace(/\s\s+/g, ' ')
        optsRight.colspan = 2
      }
      //has no col value
      if (value === '') {
        optsLeft.colspan = 3
        factor = 0.3
        delete optsLeft.backgroundColor
      }
      //make row
      let row = table.row({ padding: factor * pdf.cm })
      row.cell(key, optsLeft)
      if (interValue !== '') {
        row.cell(interValue, optsCenter)
      }
      if (value !== '') {
        row.cell(value, optsRight)
      }
      delete optsRight.colspan
      delete optsLeft.colspan
      optsLeft.backgroundColor = '#A0A0A0'
    }
  })

  doc.end()
  return doc
}
