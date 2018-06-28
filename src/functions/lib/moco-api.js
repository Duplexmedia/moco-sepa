import fetch from './paginated-fetch';
import SEPA from 'sepa';

async function mocoRequest(url, params, method = 'GET') {
    return (await fetch(`${process.env.MOCO_API}/${url}`, {
        method,
        headers: {
            'Authorization': `Token token="${process.env.MOCO_TOKEN}"`
        }
    })).data;
}

function parseDate(input) {
    if(!input) {
        throw new Error(`Invalid date: ${input}!`);
    }

    if(input.indexOf("-") !== -1) {
        return new Date(input);
    }

    const parts = input.match(/(\d+)/g);
    return new Date(parts[2], parts[1]-1, parts[0]);
}

export async function getSepaTransfers() {
    const invoices = await mocoRequest('invoices/?status=sent');

    return (await Promise.all(invoices.map(async i => {
        const project = await mocoRequest(`projects/${i.project_id}`);

        if(!project) {
            throw Error(`No project with id ${i.project_id} found!`);
        }

        if (
            !project ||
            !project.custom_properties['Zahlbar per'] ||
            project.custom_properties['Zahlbar per'] !== 'Lastschrift'
        ) {
            return;
        }

        const customer = await mocoRequest(`customers/${i.customer_id}`);

        return {
            total: i.gross_total,
            date: i.date,
            identifier: i.identifier,
            iban: customer.custom_properties['IBAN'],
            bic: customer.custom_properties['BIC'],
            debtor_name: customer.custom_properties['Kontoinhaber'],
            mandate_reference: customer.custom_properties['Mandatsreferenz'],
            mandate_date: parseDate(customer.custom_properties['Eingangsdatum des Mandates']),
            project_id: i.project_id,
            customer_id: i.customer_id,
        }
    }))).filter(i => i);
}

export async function getSepaXml() {
    const sepaDocument = new SEPA.Document('pain.008.001.02');
    sepaDocument.grpHdr.id = `DPLX.${Date.now()}.TR0`;
    sepaDocument.grpHdr.created = new Date();
    sepaDocument.grpHdr.initiatorName = process.env.CREDITOR_NAME;

    const info = sepaDocument.createPaymentInfo();
    info.collectionDate = new Date();
    info.creditorIBAN = process.env.CREDITOR_IBAN;
    info.creditorBIC = process.env.CREDITOR_BIC;
    info.creditorName = process.env.CREDITOR_NAME;
    info.creditorId = process.env.CREDITOR_ID;
    sepaDocument.addPaymentInfo(info);

    for(let s of await getSepaTransfers()) {
        const tx = info.createTransaction();
        tx.debtorName = s.debtor_name;
        tx.debtorIBAN = s.iban;
        tx.debtorBIC = 'DUSSDEDDXXX'; //s.bic;
        tx.mandateId = s.mandate_reference;
        tx.mandateSignatureDate = s.mandate_date;
        tx.amount = s.total;
        tx.remittanceInfo = s.identifier;
        tx.end2endId = `${s.mandate_reference}.${s.remittanceInfo}`;
        info.addTransaction(tx);
    }

    return sepaDocument;
}