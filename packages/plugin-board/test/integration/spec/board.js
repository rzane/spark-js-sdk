/**!
 *
 * Copyright (c) 2015-2016 Cisco Systems, Inc. See LICENSE file.
 */

import '../..';

import {assert} from '@ciscospark/test-helper-chai';
import CiscoSpark from '@ciscospark/spark-core';
import testUsers from '@ciscospark/test-helper-test-users';
import {flaky} from '@ciscospark/test-helper-mocha';
import fh from '@ciscospark/test-helper-file';
import {find, map} from 'lodash';
import uuid from 'uuid';

function generateTonsOfContents(numOfContents) {
  const contents = [];

  for (let i = 0; i < numOfContents; i++) {
    contents.push({
      type: `curve`,
      payload: JSON.stringify({id: i, type: `curve`})
    });
  }
  return contents;
}

function boardChannelToMercuryBinding(channelId) {
  // make channelId mercury compatible replace `-` with `.` and `_` with `#`
  return channelId.replace(/-/g, `.`).replace(/_/g, `#`);
}

describe(`plugin-board`, function() {
  this.timeout(30000);

  let board, conversation, fixture, participants;
  const mercuryBindingsPrefix = `board.`;

  // create users
  before(() => testUsers.create({count: 3})
    .then((users) => {
      participants = users;

      return Promise.all(map(participants, (participant) => {
        participant.spark = new CiscoSpark({
          credentials: {
            authorization: participant.token
          }
        });
        return participant.spark.device.register();
      }));
    })

    // create conversation
    .then(() => participants[0].spark.conversation.create({
      displayName: `Test Board Conversation`,
      participants
    }))
    .then((c) => {
      conversation = c;
      return conversation;
    })

    // create channel (board)
    .then(() => participants[0].spark.board.createChannel({aclUrl: conversation.id}))
    .then((channel) => {
      board = channel;
      return channel;
    })

    // connect to realtime channel
    .then(() => {
      const mercuryBindingId = boardChannelToMercuryBinding(board.channelId);
      const bindingStr = [mercuryBindingsPrefix + mercuryBindingId];
      const bindingObj = {bindings: bindingStr};

      return Promise.all(map(participants, (participant) => {
        return participant.spark.board.register(bindingObj)
          .then((url) => {
            participant.spark.board.realtime.set({
              boardWebSocketUrl: url.webSocketUrl,
              boardBindings: bindingStr
            });
            return participant.spark.board.realtime.connect();
          });
      }));
    }));

  // load fixture image
  before(() => fh.fetch(`sample-image-small-one.png`)
    .then((fetchedFixture) => {
      fixture = fetchedFixture;
      return fetchedFixture;
    }));

  // disconnect realtime
  after(() => Promise.all(map(participants, (participant) => {

    if (participant.spark.board.realtime.connected) {
      return participant.spark.board.realtime.disconnect()
        .then(() => {
          participant.spark.board.realtime.set({boardWebSocketUrl: ``});
          participant.spark.board.realtime.set({boardBindings: []});
        });
    }
    return true;
  })));

  describe(`#_uploadImage()`, () => {

    it(`uploads image to spark files`, () => {
      return participants[0].spark.board._uploadImage(conversation, fixture)
        .then((scr) => {
          return participants[0].spark.encryption.download(scr);
        })
        .then((downloadedFile) => {
          assert(fh.isMatchingFile(downloadedFile, fixture));
        });
    });
  });


  describe(`#ping()`, () => {

    it(`pings board service`, () => participants[0].spark.board.ping()
      .then((res) => {
        assert.property(res, `serviceName`);
        assert.equal(res.serviceName, `Board`);
      }));
  });

  describe(`#addImage()`, () => {
    let testContent, testScr;

    after(() => participants[0].spark.board.deleteAllContent(board));

    it(`uploads image to spark files`, () => {
      return participants[0].spark.board.addImage(conversation, board, fixture)
        .then((fileContent) => {
          testContent = fileContent[0].items[0];
          assert.equal(testContent.type, `FILE`, `content type should be image`);
          assert.property(testContent, `contentId`, `content should contain contentId property`);
          assert.property(testContent, `payload`, `content should contain payload property`);
          assert.property(testContent, `encryptionKeyUrl`, `content should contain encryptionKeyUrl property`);
        });
    });

    it(`adds to presistence`, () => {
      return participants[0].spark.board.getAllContent(board)
        .then((allContents) => {
          const imageContent = find(allContents, {contentId: testContent.contentId});
          assert.isDefined(imageContent);
          assert.property(imageContent, `scr`);
          assert.equal(imageContent.displayName, `sample-image-small-one.png`);
          testScr = imageContent.scr;
          return imageContent.scr;
        });
    });

    it(`matches file file downloaded`, () => {
      return participants[0].spark.encryption.download(testScr)
        .then((downloadedFile) => {
          assert(fh.isMatchingFile(downloadedFile, fixture));
        });
    });
  });

  describe(`#getChannels`, () => {

    it(`retrieves a newly created board for a specified conversation within a single page`, () => {
      return participants[0].spark.board.getChannels({conversationId: conversation.id})
        .then((getChannelsResp) => {
          const channelFound = find(getChannelsResp.items, {channelId: board.channelId});
          assert.isDefined(channelFound);
          assert.notProperty(getChannelsResp.links, `next`);
        });
    });

    it(`retrieves all boards for a specified conversation across multiple pages`, () => {
      const pageLimit = 10;
      let conversation;

      return participants[0].spark.conversation.create({
        displayName: `Test Board Conversation`,
        participants
      })
        .then((conversationResp) => {
          conversation = conversationResp;
          const promises = [];

          for (let i = 0; i < pageLimit + 1; i++) {
            promises.push(participants[0].spark.board.createChannel({
              aclUrl: conversation.id
            }));
          }
          return Promise.all(promises);
        })
        .then(() => {
          return participants[0].spark.board.getChannels({
            conversationId: conversation.id,
            channelsLimit: pageLimit
          });
        })
        .then((channelPage) => {
          assert.lengthOf(channelPage.items, pageLimit);
          assert(channelPage.hasNext());
          return channelPage.next();
        })
        .then((channelPage) => {
          assert.lengthOf(channelPage.items, 1);
          assert(!channelPage.hasNext());
        });
    });
  });

  describe(`#getContents()`, () => {

    afterEach(() => participants[0].spark.board.deleteAllContent(board));

    it(`adds and gets contents from the specified board`, () => {
      const contents = [{type: `curve`}];
      const data = [{
        type: contents[0].type,
        payload: JSON.stringify(contents[0])
      }];

      return participants[0].spark.board.addContent(conversation, board, data)
        .then(() => {
          return participants[0].spark.board.getAllContent(board);
        })
        .then((res) => {
          assert.equal(res[0].payload, data[0].payload);
        });
    });

    flaky(it)(`can deal with tons of contents by pagination`, () => {
      const tonsOfContents = generateTonsOfContents(2100);

      return participants[0].spark.board.addContent(conversation, board, tonsOfContents)
        .then(() => {
          return participants[0].spark.board.getAllContent(board);
        })
        .then((res) => {
          assert.equal(res.length, tonsOfContents.length);
          for (let i = 0; i < res.length; i++) {
            assert.equal(res[i].payload, tonsOfContents[i].payload);
          }
        });
    });
  });

  describe(`#deleteContent()`, () => {

    after(() => participants[0].spark.board.deleteAllContent(board));

    it(`delete contents from the specified board`, () => {
      const channel = board;
      const contents = [
        {
          id: uuid.v4(),
          type: `file`
        },
        {
          id: uuid.v4(),
          type: `string`
        }
      ];
      const data = [
        {
          type: contents[0].type,
          payload: JSON.stringify(contents[0])
        },
        {
          type: contents[1].type,
          payload: JSON.stringify(contents[1])
        }
      ];

      return participants[0].spark.board.addContent(conversation, channel, data)
        .then(() => {
          return participants[0].spark.board.deleteAllContent(channel);
        })
        .then(() => {
          return participants[0].spark.board.getAllContent(channel);
        })
        .then((res) => {
          assert.equal(res.length, 0);
          return res;
        })
        .then(() => {
          return participants[0].spark.board.addContent(conversation, channel, data);
        })
        .then((res) => {
          assert.equal(res[0].items.length, 2);
          const content = res[0].items[0];
          console.log(`contentId: `, content.contentId);
          return participants[0].spark.board.deleteContent(channel, content);
        })
        .then(() => {
          return participants[0].spark.board.getAllContent(channel);
        })
        .then((res) => {
          assert.equal(res.length, 1);
          assert.equal(res[0].payload, data[1].payload);
          return res;
        });
    });
  });

  describe(`realtime`, () => {
    describe(`#config`, () => {

      it(`shares board values`, () => {
        // board values
        assert.isDefined(participants[0].spark.board.realtime.config.pingInterval);
        assert.isDefined(participants[0].spark.board.realtime.config.pongTimeout);
        assert.isDefined(participants[0].spark.board.realtime.config.forceCloseDelay);

        // mercury values not defined in board
        assert.isUndefined(participants[0].spark.board.realtime.config.backoffTimeReset);
        assert.isUndefined(participants[0].spark.board.realtime.config.backoffTimeMax);
      });
    });

    describe(`#publish()`, () => {
      describe(`string payload`, () => {
        let uniqueRealtimeData;

        before(() => {
          uniqueRealtimeData = uuid.v4();
        });

        it(`posts a message to the specified board`, (done) => {
          const data = {
            envelope: {
              channelId: board,
              roomId: conversation.id
            },
            payload: {
              msg: uniqueRealtimeData
            }
          };

          // participan 1 is going to listen for RT data and confirm that we
          // have the same data that was sent.
          participants[1].spark.board.realtime.once(`event:board.activity`, ({data}) => {
            assert.equal(data.contentType, `STRING`);
            assert.equal(data.payload.msg, uniqueRealtimeData);
            done();
          });

          // confirm that both are connected.
          assert.isTrue(participants[0].spark.board.realtime.connected, `participant 0 is connected`);
          assert.isTrue(participants[1].spark.board.realtime.connected, `participant 1 is connected`);

          // do not return promise because we want done() to be called on
          // board.activity
          participants[0].spark.board.realtime.publish(conversation, data);
        });
      });

      describe(`file payload`, () => {
        let testScr;

        it(`uploads file to spark files which includes loc`, () => {
          return participants[1].spark.board._uploadImage(conversation, fixture)
            .then((scr) => {
              assert.property(scr, `loc`);
              testScr = scr;
            });
        });

        it(`posts a file to the specified board`, (done) => {

          const data = {
            envelope: {
              channelId: board,
              roomId: conversation.id
            },
            payload: {
              displayName: `image.png`,
              scr: testScr
            }
          };

          // participant 1 is going to listen for RT data and confirm that we have the
          // same data that was sent.
          participants[1].spark.board.realtime.once(`event:board.activity`, ({data}) => {
            assert.equal(data.contentType, `FILE`);
            assert.equal(data.payload.scr.loc, testScr.loc);
            assert.equal(data.payload.displayName, `image.png`);
            done();
          });

          // confirm that both are listening.
          assert.isTrue(participants[0].spark.board.realtime.connected, `participant 0 is connected`);
          assert.isTrue(participants[1].spark.board.realtime.connected, `participant 1 is listening`);

          // do not return promise because we want done() to be called on
          // board.activity
          participants[0].spark.board.realtime.publish(conversation, data);
        });
      });
    });
  });
});
