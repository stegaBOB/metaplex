// import { EXTENSION_JSON, EXTENSION_PNG } from '../helpers/constants';
// import path from 'path';
import {
  createConfig,
  loadCandyProgram,
  loadWalletKey,
} from '../helpers/accounts';
import { PublicKey } from '@solana/web3.js';
// import fs from 'fs';
import { BN } from '@project-serum/anchor';
import { loadCache, saveCache } from '../helpers/cache';
import log from 'loglevel';
// import { awsUpload } from '../helpers/upload/aws';
// import { arweaveUpload } from '../helpers/upload/arweave';
// import { ipfsCreds, ipfsUpload } from '../helpers/upload/ipfs';
import { chunks } from '../helpers/various';

export async function upload(
  setupFile: string,
  cacheName: string,
  env: string,
  keypair: string,
  totalNFTs: number,
  retainAuthority: boolean,
  mutable: boolean,
  rpcUrl: string,
  arweaveManifest: string,
  batchSize: number,
  // storage: string,
  // awsS3Bucket: string,
  // ipfsCredentials: ipfsCreds,
): Promise<boolean> {
  let uploadSuccessful = true;

  const savedContent = loadCache(cacheName, env);
  const cacheContent = savedContent || {};

  if (!cacheContent.program) {
    cacheContent.program = {};
  }

  if (!cacheContent.items) {
    cacheContent.items = {};
  }

  // const seen = {};
  // const newFiles = [];

  // files.forEach(f => {
  //   if (!seen[f.replace(EXTENSION_PNG, '').split('/').pop()]) {
  //     seen[f.replace(EXTENSION_PNG, '').split('/').pop()] = true;
  //     newFiles.push(f);
  //   }
  // });
  // existingInCache.forEach(f => {
  //   if (!seen[f]) {
  //     seen[f] = true;
  //     newFiles.push(f + '.png');
  //   }
  // });

  // const images = newFiles.filter(val => path.extname(val) === EXTENSION_PNG);
  // const SIZE = images.length;

  const walletKeyPair = loadWalletKey(keypair);
  const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);

  let config = cacheContent.program.config
    ? new PublicKey(cacheContent.program.config)
    : undefined;

  log.debug('Processing config data');

  const link = cacheContent?.items?.[0]?.link;
  if (!link || !cacheContent.program.uuid) {
    const manifest = JSON.parse(setupFile);
    if (!cacheContent.program.uuid) {
      log.info(`initializing config`);
      try {
        const res = await createConfig(anchorProgram, walletKeyPair, {
          maxNumberOfLines: new BN(totalNFTs),
          symbol: manifest.symbol,
          arweaveManifest: arweaveManifest,
          sellerFeeBasisPoints: manifest.seller_fee_basis_points,
          isMutable: mutable,
          maxSupply: new BN(0),
          retainAuthority: retainAuthority,
          creators: manifest.creators.map(creator => {
            return {
              address: new PublicKey(creator.address),
              verified: true,
              share: creator.share,
            };
          }),
        });
        cacheContent.program.uuid = res.uuid;
        cacheContent.program.config = res.config.toBase58();
        config = res.config;
        cacheContent.arweaveManifest = arweaveManifest;
        cacheContent.totalNFTs = totalNFTs;

        log.info(
          `initialized config for a candy machine with publickey: ${res.config.toBase58()}`,
        );

        saveCache(cacheName, env, cacheContent);
      } catch (exx) {
        log.error('Error deploying config to Solana network.', exx);
        throw exx;
      }
    }
  }

  saveCache(cacheName, env, cacheContent);

  const keys = Object.keys(cacheContent.items);
  if (keys.length !== parseInt(cacheContent.totalNFTs || totalNFTs)) {
    log.info(
      `Please add ${cacheContent.totalNFTs} item(s) to the cache file before rerunning`,
    );
  } else {
    try {
      await Promise.all(
        chunks(Array.from(Array(keys.length).keys()), batchSize || 1000).map(
          async allIndexesInSlice => {
            for (
              let offset = 0;
              offset < allIndexesInSlice.length;
              offset += 10
            ) {
              const indexes = allIndexesInSlice.slice(offset, offset + 10);
              const onChain = indexes.filter(i => {
                const index = keys[i];
                return cacheContent.items[index]?.onChain || false;
              });
              const ind = keys[indexes[0]];

              if (onChain.length != indexes.length) {
                log.info(
                  `Writing indices ${ind}-${keys[indexes[indexes.length - 1]]}`,
                );
                try {
                  await anchorProgram.rpc.addConfigLines(
                    ind,
                    indexes.map(i => ({
                      uri: cacheContent.items[keys[i]].link,
                      name: cacheContent.items[keys[i]].name,
                    })),
                    {
                      accounts: {
                        config,
                        authority: walletKeyPair.publicKey,
                      },
                      signers: [walletKeyPair],
                    },
                  );
                  indexes.forEach(i => {
                    cacheContent.items[keys[i]] = {
                      ...cacheContent.items[keys[i]],
                      onChain: true,
                    };
                  });
                  saveCache(cacheName, env, cacheContent);
                } catch (e) {
                  log.error(
                    `saving config line ${ind}-${
                      keys[indexes[indexes.length - 1]]
                    } failed`,
                    e,
                  );
                  uploadSuccessful = false;
                }
              }
            }
          },
        ),
      );
    } catch (e) {
      log.error(e);
    } finally {
      saveCache(cacheName, env, cacheContent);
    }
  }
  log.info(
    `${keys.length} items out of ${cacheContent.totalNFTs} are in cache file`,
  );
  console.log(`Done. Successful = ${uploadSuccessful}.`);
  return uploadSuccessful;
}
