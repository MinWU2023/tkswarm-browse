/**
 * UI / 菜单「测试环境窗」：不走代理，固定打开 https://www.dyyseo.com
 */
const { mergeFingerprint } = require('./fingerprint');

const TEST_PROFILE_ID = '__ui-test-dyyseo__';
const TEST_URL = 'https://www.dyyseo.com';

function buildTestProfile() {
  const fp = mergeFingerprint({});
  return {
    id: TEST_PROFILE_ID,
    name: '环境窗测试-dyyseo',
    platform: TEST_URL,
    fingerprint_json: JSON.stringify(fp),
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    proxy_type: 'noproxy',
    proxyType: 'noproxy',
    host: '',
    port: '',
    username: '',
    password: '',
    owner_id: 0,
  };
}

function isTestProfileId(profileId) {
  return String(profileId) === TEST_PROFILE_ID;
}

module.exports = {
  TEST_PROFILE_ID,
  TEST_URL,
  buildTestProfile,
  isTestProfileId,
};
