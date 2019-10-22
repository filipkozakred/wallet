import { Meteor } from 'meteor/meteor';
import standardABI from 'human-standard-token-abi';
import { TAPi18n } from 'meteor/tap:i18n';
import { Contracts } from '/imports/api/contracts/Contracts';
import { Transactions } from '/imports/api/transactions/Transactions';

import { BigNumber } from 'bignumber.js';
import { migrateAddress, getContractObject, getTransactionObject, parseContent, getClosingObject } from '/lib/interpreter';

import { log } from '/lib/const';

const Web3 = require('web3');
const ethUtil = require('ethereumjs-util');
const abiDecoder = require('abi-decoder');
const numeral = require('numeral');

const START_BLOCK = 5000000;
let web3;

/**
* @summary check web3 plugin and connects to code obejct
*/
const _web3 = () => {
  if (!web3) {
    log('[web3] Connecting to Ethereum node...');
    web3 = new Web3(Meteor.settings.public.web3.network);
  }
  return web3;
};

/**
* @summary show all the transactions for a given public address
* @param {string} publicAddress of a contract.
*/
const _getContract = async (publicAddress, interfaceJSON) => {
  if (_web3()) {
    log(`[web3] Getting contract ABI of ${publicAddress}.`);
    const abi = JSON.parse(interfaceJSON);

    if (abi) {
      log(abi);
      const contract = new web3.eth.Contract(abi, publicAddress);
      log('[web3] JSON Interface:');
      log(contract);
      return contract;
    }
  }
  return undefined;
};

/*
Example of a contract default:
*/

const _getMembership = (address, values) => {
  let membershipType = '';
  _.filter(values, (num, key) => {
    if (num === address) {
      switch (key) {
        case 'delegateKey':
          membershipType = 'DELEGATE';
          break;
        case 'memberAddress':
          membershipType = 'MEMBER';
          break;
        case 'applicant':
          membershipType = 'APPLICANT';
          break;
        default:
          membershipType = 'ADDRESS';
          break;
      }
      return true;
    }
    return false;
  });
  return membershipType;
};

const _timestampToDate = (timestamp) => {
  const date = new Date(timestamp * 1000);
  return `/${date.getFullYear()}/${parseInt(date.getMonth() + 1, 10)}/${date.getDate()}/`;
};

const _setContract = (keyword, contractObject) => {
  const dbContract = Contracts.findOne({ keyword });
  if (dbContract) {
    log('[web3] Updating existing contract...');

    Contracts.update({ _id: dbContract._id }, { $set: contractObject }, (err, res) => {
      if (err) {
        log(err);
      }
      return res;
    });
    return dbContract._id;
  }
  log('[web3] Inserting new contract..');
  return Contracts.insert(contractObject, (err, res) => {
    if (err) {
      log(err);
    }
    return res;
  });
};

const _setTransaction = (userId, pollId, transactionObject) => {
  const dbContract = Transactions.findOne({ $and: [{ 'input.entityId': userId }, { 'output.entityId': pollId }] });
  if (dbContract) {
    log('[web3] Updating existing contract...');
    Transactions.update({ _id: dbContract._id }, { $set: transactionObject }, (err, res) => {
      if (err) {
        log(err);
      }
      return res;
    });
    return dbContract._id;
  }
  log('[web3] Inserting new contract..');
  return Transactions.insert(transactionObject, (err, res) => {
    if (err) {
      log(err);
    }
    return res;
  });
};

const _getAddressList = (res, collectiveId) => {
  let settings;
  let membership;
  let authorUsername;
  const addresses = _.uniq(_.filter(res.returnValues, (num) => { if (typeof num === 'string') { return web3.utils.isAddress(num); } return false; }));
  for (let i = 0; i < addresses.length; i += 1) {
    membership = _getMembership(addresses[i], res.returnValues);
    if (membership === 'MEMBER') {
      authorUsername = addresses[i].toLowerCase();
    }
    settings = {
      profile: {
        membership,
        collectives: [collectiveId],
      },
    };
    migrateAddress(addresses[i], settings);
  }
  return authorUsername;
};

/**
* @summary from a log event on chain persists it into a contract database record
* @param {object} log with event descriptions from the blockchain
* @param {object} map with info how to write these eventos on the blockchain
* @param {object} state of the current smart contract being processed
* @param {string} collectiveId this is being subscribed to
*/
const _mirrorContract = (event, map, state, collectiveId) => {
  log(`[web3] Mirroring blockchain event as contract action with collectiveId: ${collectiveId}...`);

  // create users required for this contract
  const authorUsername = _getAddressList(event, collectiveId);
  const user = Meteor.users.findOne({ username: authorUsername });

  if (user) {
    const blockDate = web3.eth.getBlock(event.blockNumber, (err, res) => {
      log(event);
      if (!err) {
        const block = res;
        const index = new BigNumber(event.returnValues.proposalIndex).toString();
        const returnValues = event.returnValues;

        const userInfo = Meteor.users.findOne({ username: returnValues.applicant.toLowerCase() });
        if (userInfo) {
          returnValues.applicantId = userInfo._id;
        }
        const contract = {
          title: parseContent(TAPi18n.__(map.contract.title), returnValues),
          keyword: `${event.transactionHash}`,
          url: `${_timestampToDate(block.timestamp)}${event.transactionHash}`,
          date: new Date(block.timestamp * 1000),
          publicAddress: event.returnValues.delegateKey,
          height: event.blockNumber,
          calendar: new Date(block.timestamp * 1000),
          importId: index,
          pollChoiceId: '',
          pollId: '',
          collectiveId,
          closing: getClosingObject(state, event.blockNumber),
        };

        const contractObject = getContractObject(user, contract);
        const newContractId = _setContract(contract.keyword, contractObject);

        // poll
        if (map.contract.rules.pollVoting) {
          const choices = ['no', 'yes'];
          const choiceContract = [];
          let choice;
          let contractPollChoice;
          for (let k = 0; k < choices.length; k += 1) {
            choice = contract;
            choice.title = TAPi18n.__(`moloch-${choices[k]}`);
            choice.keyword = `${event.transactionHash}/${choices[k]}`;
            choice.pollChoiceId = k.toString();
            choice.pollId = newContractId;
            contractPollChoice = getContractObject(user, choice);
            choiceContract.push(_setContract(choice.keyword, contractPollChoice));
          }

          // create poll data array
          const finalPoll = [];
          for (let n = 0; n < choiceContract.length; n += 1) {
            finalPoll.push({
              contractId: choiceContract[n],
              totalStaked: '0',
            });
          }
          // update original contract
          Contracts.update({ _id: newContractId }, { $set: { poll: finalPoll } });
          log(`[web3] Poll added to contract: ${newContractId}`);
        }
      }
    });
  }
};


/**
* @summary from a log event on chain persists it into a transaction database record
* @param {object} log with event descriptions from the blockchain
* @param {object} map with info how to write these eventos on the blockchain
* @param {string} collectiveId this is being subscribed to
*/
const _mirrorTransaction = (event, map, collectiveId) => {
  log(`[web3] Mirroring blockchain event as transaction action with collectiveId: ${collectiveId}...`);
  log(event);

  // create users required for this transaction
  const authorUsername = _getAddressList(event, collectiveId);
  const user = Meteor.users.findOne({ username: authorUsername });
  const index = new BigNumber(event.returnValues.proposalIndex).toString();
  
  if (user) {
    const contract = Contracts.findOne({ importId: index });
    if (contract) {
      let poll;
      switch (event.returnValues.uintVote) {
        case 1: // yes
          poll = Contracts.findOne({ keyword: `${contract.keyword}/yes` });
          break;
        case 2: // no
          poll = Contracts.findOne({ keyword: `${contract.keyword}/no` });
          break;
        default:
      }
      if (poll) {
        const blockDate = web3.eth.getBlock(event.blockNumber, (err, res) => {
          if (!err) {
            const block = res;
            const ticket = {
              timestamp: new Date(block.timestamp * 1000),
              contract: {
                _id: contract._id,
              },
              poll: {
                _id: poll._id,
              },
              address: contract.keyword,
            };

            const transactionObject = getTransactionObject(user, ticket);
            log('Transaction object:');
            const userId = user._id;
            const pollId = poll._id;
            _setTransaction(userId, pollId, transactionObject);
            // log(transactionObject);
          } else {
            log(err);
          }
        });
      }
    }
  }
};

/**
* @summary writes the event log found on the blockchain to database objects according to mapping structure
* @param {object} log with event descriptions from the blockchain
* @param {object} smartContract with info how to write these eventos on the blockchain
* @param {string} collectiveId this is being subscribed to
*/
const _writeEvents = (event, smartContract, state, collectiveId) => {
  log('[web3] Writing events found on the blockchain to local database...');
  const map = smartContract.map;

  for (let i = 0; i < event.length; i += 1) {
    for (let k = 0; k < map.length; k += 1) {
      if (map[k].eventName === event[i].event) {
        log(`[web3] Processing event: ${event[i].event}`);
        log(`[web3] Adding a new ${map[k].collectionType}`);
        if (map[k].eventName === event[i].event) {
          switch (map[k].collectionType) {
            case 'Transaction':
              break;
            case 'Contract':
              if (event[i].event === 'SubmitProposal') {
                _mirrorContract(event[i], map[k], state, collectiveId);
              }
              if (event[i].event === 'SubmitVote') {
                _mirrorTransaction(event[i], map[k], collectiveId);
              }
              break;
            default:
          }
        }
      }
    }
  }
};

const _updateWallet = async (publicAddress, token) => {
  if (_web3()) {
    const coin = getCoin(token);
    log(`contractAddress: ${coin.contractAddress}`);
    log(`publicAddress: ${publicAddress}`);

    const contract = new web3.eth.Contract(standardABI, coin.contractAddress);
    contract.methods.balanceOf(publicAddress).call({ name: publicAddress }, (error, balance) => {
      log('INSIDE BALANCE OF');
      log(balance);
      contract.methods.decimals().call((error, decimals) => {
        balance = balance.div(10 ** decimals);
        log(balance.toString());
      });
    })
  }
};

/**
* @summary given a list of parameters it will obtain the current state value on chain
* @param {object} smartContract object from a collective
*/
const _getState = async (smartContract) => {
  const state = {};
  const abi = JSON.parse(smartContract.abi);

  log('[web3] Parsing current state of smart contract...');
  const dao = await new web3.eth.Contract(abi, smartContract.publicAddress);

  if (smartContract.parameter) {
    for (let i = 0; i < smartContract.parameter.length; i += 1) {
      if (dao.methods[smartContract.parameter[i].name]) {
        log(`[web3] Asking for parameter: ${smartContract.parameter[i].name}`);
        await dao.methods.proposalQueue(0).call({}, (err, res) => {
          console.log('PROPOSAL QUEUE:');
          console.log(res);
        // await dao.methods[smartContract.parameter[i].name].call({}, (err, res) => {
          if (err) {
            log(err);
          }
          state[smartContract.parameter[i].name] = res;
          return res;
        });
      }
    }
  }
  return state;
};

/**
* @summary show all the transactions for a given public address
* @param {object} smartContract object from a collective
* @param {string} collectiveId this is being subscribed to
*/
const _getEvents = async (smartContract, collectiveId) => {
  let eventLog;

  if (_web3()) {
    log(`[web3] Getting past events for ${smartContract.publicAddress}..`);
    const abi = JSON.parse(smartContract.abi);

    if (abi) {
      const state = await _getState(smartContract);
      console.log(state);
/*
      await new web3.eth.Contract(abi, smartContract.publicAddress).getPastEvents('allEvents', {
        fromBlock: START_BLOCK,
        toBlock: 'latest',
      }, (error, res) => {
        if (error) {
          log('[web3] Error fetching log data.');
          log(error);
        } else {
          log(`[web3] Log for ${smartContract.publicAddress} has a length of ${res.length} events.`);
          log(`[web3] Events consist of: ${JSON.stringify(_.uniq(_.pluck(res, 'event')))}`);

          if (res.length > 0 && smartContract.map && smartContract.map.length > 0) {
            _writeEvents(res, smartContract, state, collectiveId);
          }
        }
        return res;
      }).then((res) => {
        eventLog = res;
        return res;
      }); */
    }
  }
  return eventLog;
};


if (Meteor.isServer) {
  _web3();
}

export const updateWallet = _updateWallet;
export const getEvents = _getEvents;
export const getContract = _getContract;
