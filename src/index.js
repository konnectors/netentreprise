const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  log,
  htmlToPDF,
  saveBills
} = require('cozy-konnector-libs')
const moment = require('moment')
const pdf = require('pdfjs')

const request = requestFactory({
  debug: false,
  cheerio: true,
  json: false,
  jar: true
})

const baseUrl = 'https://net-entreprise.fr/'
const serviceUrl = 'https://portail.net-entreprises.fr/priv/'
const urssafUrl = 'https://www.ti.urssaf.fr/'
module.exports = new BaseKonnector(start)

async function start(fields) {
  let accData = this.getAccountData();
  log('info', 'Authenticating ...');
  //Auth and retrieve declaration URL
  const urlDeclaration = await authenticate(
    fields.siret,
    fields.lastname,
    fields.firstname,
    fields.password
  );
  log('info', 'Successfully logged in');

  log('info', 'Get Declarations Parameters');
  let params = await getDeclarationsParameters(urlDeclaration);
  log('info', 'Get Declaration ');
  const declarationList = await buildDeclarationList(params);
  const bills = await getAllDeclaration(params, declarationList, accData);

  await saveBills(bills,fields, {
    identifiers: ['net-entreprise'],
    contentType: 'application/pdf'
  });
}

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

async function getAllDeclaration(params, declarationList, accData) {
  let exist = Object.keys(accData).length > 0
  let bills = [];
  if (!exist || accData.lastPeriod !== params.periode - 1) {
    let lastPeriod = declarationList.length
    if (exist) {
      lastPeriod = declarationList.indexOf(accData.lastPeriod)
      if (lastPeriod === -1) lastPeriod = declarationList.length
    }

    for (let i = 0; i < lastPeriod; i++) {
      const bill = await getDeclaration(params, declarationList[i])
      bills.push(bill);
      break;
    }
  }
  return bills;
}

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
  });
  let subData = scrape(data('#table-paiements-tldp .cellule_droite_middle'),{
    amount: {
      sel: 'span#libmtpai',
      parse: value => parseInt(value)
    }
  });
  let bill = {};
  bill.amount = subData.amount;
  subData = scrape(data,{
    date: {
      sel: 'span.text_grand_gras',
    }
  },'.tableau_donnees_cons .cellule_droite_middle');
  subData = subData[3].date.substring(1).trim().substring(3).substring(0,10).trim();
  moment.locale('fr');
  subData = subData.split('/');
  let day = parseInt(subData[0])+1;
  day = day < 10 ? '0'+day.toString() : day.toString();
  bill.date = moment(''+subData[2]+'-'+subData[1]+'-'+day);
  bill.vendor = 'urssaf';
  bill.filename = bill.date.format('YYYY-MM')+'.pdf';
  bill.date = bill.date.toDate();
  bill.filestream = await declarationToStream(data);
  return bill;
}


async function declarationToStream(data) {
  var doc = new pdf.Document();
  const cell = doc.cell({ paddingBottom: 0.5 * pdf.cm }).text()
  cell.add('Généré automatiquement par le connecteur Netflix depuis la page ', {
    font: require('pdfjs/font/Helvetica-Bold'),
    fontSize: 14
  })
  htmlToPDF(data,doc,data('.tableau_donnees_cons'),{});
  doc.end();
  return doc;
}
