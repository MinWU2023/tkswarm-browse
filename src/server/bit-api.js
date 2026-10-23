const express = require('express');
const db = require('../db');
const manager = require('../browser/manager');
const { mergeFingerprint } = require('../browser/fingerprint');
const { getCurrentUser } = require('../db');
const { resolveEngine } = require('../browser/engine');
const { DATA_ROOT } = require('../config');
const { probeExitIp } = require('../browser/exit-ip');
const { lookupGeoByIp, applyIpCreateFields } = require('../browser/geo-from-ip');
const { clearProfileCache, removeProfileDir } = require('../browser/profile-cleanup');

function ok(data) {
  return { success: true, code: 0, data };
}

function fail(msg, code = 1) {
  return { success: false, code, msg: String(msg) };
}

function authMiddleware(req, res, next) {
  const user = getCurrentUser();
  if (!user) {
    return res.json(fail('Login out'));
  }
  // 桌面端已登录即可；Node 侧 Bearer 可能与本地会话轮换不一致，不再校验 Token
  req.currentUser = user;
  next();
}

/**
 * 环境权限：本机环境共用（任意登录用户可打开/查看）；写操作仍限创建者或超管。
 * 创建额度 300/用户 在 db.createProfile 单独校验，与打开权限无关。
 */
function assertProfileOwner(user, profile, opts = {}) {
  const write = !!opts.write;
  if (!profile) return { ok: false, msg: 'browser环境不存在或已删除' };
  if (Number(user.is_super) === 1) return { ok: true };
  if (!write) return { ok: true };
  const owner = Number(profile.owner_id || 0);
  if (owner === 0 || owner === Number(user.id)) return { ok: true };
  return { ok: false, msg: '无权修改该浏览器环境（仅创建者可删除或改配置）' };
}

function toBitProfile(row, runtime = null) {
  if (!row) return null;
  const fp = JSON.parse(row.fingerprint_json || '{}');
  const status = runtime
    ? (runtime.headless ? 1 : 2)
    : (row.status === 'running' || row.status === 'headless' ? 1 : 0);
  return {
    id: row.id,
    seq: row.seq,
    code: row.id.slice(0, 8),
    name: row.name,
    remark: row.remark,
    groupId: row.group_id || 'default',
    status,
    platform: row.platform,
    proxyType: row.proxy_type,
    host: row.proxy_host,
    port: row.proxy_port,
    proxyUserName: row.proxy_user,
    proxyPassword: row.proxy_pass,
    country: row.country || '',
    lastIp: row.last_ip || '',
    latitude: row.latitude || 0,
    longitude: row.longitude || 0,
    coreProduct: fp.coreProduct || 'chrome',
    coreVersion: fp.coreVersion || '131',
    browserFingerPrint: fp,
    fingerprint: fp,
    ua: fp.userAgent,
    timezone: row.timezone,
    language: row.language,
    createdTime: row.created_at,
    updateTime: row.updated_at,
    ownerId: row.owner_id,
  };
}

async function resolveGeoFromProxy(proxyFields, fp, body = {}) {
  let lastIp = '';
  let geo = {};
  if (proxyFields.proxy_type && proxyFields.proxy_type !== 'noproxy' && proxyFields.proxy_host) {
    const probed = await probeExitIp(proxyFields).catch(() => ({ ip: '' }));
    lastIp = probed?.ip || '';
    if (lastIp) geo = await lookupGeoByIp(lastIp).catch(() => ({}));
  }
  const fields = applyIpCreateFields(fp, geo, body);
  return { lastIp, geo, fields };
}

function createRouter() {
  const router = express.Router();

  // health 无需登录也能探活（节点设置页「检测」）；list/open 仍需登录
  router.post('/health', (req, res) => {
    const user = getCurrentUser();
    res.json(ok({
      status: 'ok',
      provider: 'tkswarm-browses',
      loggedIn: !!user,
      engine: resolveEngine(),
      version: '1.0.0',
      dataRoot: DATA_ROOT,
    }));
  });

  router.post('/group/list', authMiddleware, (req, res) => {
    const page = Number(req.body?.page || 0);
    const pageSize = Number(req.body?.pageSize || 100);
    const user = req.currentUser;
    const ownerFilter = Number(user.is_super) === 1 ? null : Number(user.id);
    const all = db.listGroups({ ownerId: ownerFilter });
    const limit = Math.min(500, Math.max(1, pageSize));
    const offset = Math.max(0, page) * limit;
    const list = all.slice(offset, offset + limit).map((g) => ({
      id: g.id,
      name: g.name,
      sort: g.sort || 0,
    }));
    res.json(ok({ list, page, pageSize: limit, totalNum: all.length }));
  });

  router.post('/group/add', authMiddleware, (req, res) => {
    try {
      const user = req.currentUser;
      const row = db.createGroup({
        name: req.body?.groupName || req.body?.name || '未命名分组',
        ownerId: user.id,
        sort: Number(req.body?.sort || 0),
      });
      res.json(ok({ id: row.id, name: row.name, sort: row.sort }));
    } catch (e) {
      res.json(fail(e.message || '创建分组失败'));
    }
  });

  router.post('/group/edit', authMiddleware, (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.updateGroup(id, {
        name: req.body?.groupName || req.body?.name,
        sort: req.body?.sort,
      });
      if (!row) return res.json(fail('分组不存在'));
      res.json(ok(row));
    } catch (e) {
      res.json(fail(e.message || '编辑分组失败'));
    }
  });

  router.post('/group/delete', authMiddleware, (req, res) => {
    try {
      const id = String(req.body?.id || '');
      db.deleteGroup(id);
      res.json(ok({ ok: true }));
    } catch (e) {
      res.json(fail(e.message || '删除分组失败'));
    }
  });

  router.post('/browser/list', authMiddleware, (req, res) => {
    const page = Number(req.body?.page || 0);
    const pageSize = Number(req.body?.pageSize || 100);
    const name = String(req.body?.name || '');
    const groupId = req.body?.groupId != null ? String(req.body.groupId) : null;
    // 本机环境共用：列表展示全部本地环境；创建额度仍按用户 owner_id 计数
    const pack = db.listProfiles({ page, pageSize, name, ownerId: null, groupId });
    const windows = manager.listWindows();
    const winMap = new Map(windows.map((w) => [w.profileId, w]));
    const list = pack.list.map((row) => toBitProfile(row, winMap.get(row.id)));
    res.json(ok({ list, page: pack.page, pageSize: pack.pageSize, totalNum: pack.totalNum }));
  });

  router.post('/browser/detail', authMiddleware, (req, res) => {
    const id = String(req.body?.id || '');
    const row = db.getProfile(id);
    const gate = assertProfileOwner(req.currentUser, row);
    if (!gate.ok) return res.json(fail(gate.msg));
    const runtime = manager.getSession(id);
    res.json(ok(toBitProfile(row, runtime)));
  });

  router.post('/browser/open', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row);
      if (!gate.ok) return res.json(fail(gate.msg));
      const args = req.body?.args;
      const headless = Array.isArray(args) && args.some((a) => /headless/i.test(String(a)));
      const data = await manager.openProfile(id, {
        headless,
        args,
        queue: req.body?.queue !== false,
        forceRelaunch: Boolean(req.body?.forceRelaunch || req.body?.force_relaunch),
      });
      res.json(ok(data));
    } catch (e) {
      res.json(fail(e.message || '打开失败'));
    }
  });

  router.post('/browser/close', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row);
      if (!gate.ok) return res.json(fail(gate.msg));
      await manager.closeProfile(id);
      res.json(ok({ ok: true }));
    } catch (e) {
      res.json(fail(e.message || '关闭失败'));
    }
  });

  router.post('/browser/delete', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row, { write: true });
      if (!gate.ok) return res.json(fail(gate.msg));
      await manager.closeProfile(id).catch(() => {});
      db.deleteProfile(id);
      removeProfileDir(id);
      res.json(ok({ ok: true }));
    } catch (e) {
      res.json(fail(e.message || '删除失败'));
    }
  });

  /** 清 Cookie / Cache（不删环境）；需先关闭窗口 */
  router.post('/browser/clear', authMiddleware, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row, { write: true });
      if (!gate.ok) return res.json(fail(gate.msg));
      if (manager.getSession(id)) {
        await manager.closeProfile(id);
      }
      const result = clearProfileCache(id);
      res.json(ok(result));
    } catch (e) {
      res.json(fail(e.message || '清理失败'));
    }
  });

  router.post('/browser/proxy/update', authMiddleware, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const proxyType = String(req.body?.proxyType || 'noproxy');
      const host = String(req.body?.host || '');
      const port = Number(req.body?.port || 0);
      const proxyUserName = req.body?.proxyUserName || '';
      const proxyPassword = req.body?.proxyPassword || '';
      const proxyFields = {
        proxy_type: proxyType,
        proxy_host: host,
        proxy_port: port,
        proxy_user: proxyUserName,
        proxy_pass: proxyPassword,
      };

      let lastIp = '';
      let fields = { timezone: '', language: '', latitude: 0, longitude: 0, country: '' };
      for (const id of ids) {
        const row = db.getProfile(id);
        const gate = assertProfileOwner(req.currentUser, row);
        if (!gate.ok) return res.json(fail(gate.msg));
        const fp = JSON.parse(row.fingerprint_json || '{}');
        const resolved = await resolveGeoFromProxy(proxyFields, fp, {});
        lastIp = resolved.lastIp;
        fields = resolved.fields;
        db.updateProfileProxy(id, {
          proxyType,
          host,
          port,
          proxyUserName,
          proxyPassword,
          lastIp,
          timezone: fields.timezone,
          language: fields.language,
          latitude: fields.latitude,
          longitude: fields.longitude,
          country: fields.country,
        });
        if (manager.getSession(id)) {
          await manager.closeProfile(id).catch(() => {});
        }
      }
      res.json(ok({ ok: true, lastIp, timezone: fields.timezone, language: fields.language }));
    } catch (e) {
      res.json(fail(e.message || '代理更新失败'));
    }
  });

  router.post('/browser/update', authMiddleware, async (req, res) => {
    try {
      const user = req.currentUser;
      const body = req.body || {};
      const existingId = String(body.id || '').trim();
      const fp = mergeFingerprint(body.browserFingerPrint || body);
      const hasProxy = body.proxyType && body.proxyType !== 'noproxy' && body.host;
      const proxyFields = {
        proxy_type: hasProxy ? body.proxyType : 'noproxy',
        proxy_host: hasProxy ? String(body.host) : '',
        proxy_port: hasProxy ? Number(body.port) : 0,
        proxy_user: hasProxy ? String(body.proxyUserName || '') : '',
        proxy_pass: hasProxy ? String(body.proxyPassword || '') : '',
      };
      const { lastIp, fields } = await resolveGeoFromProxy(proxyFields, fp, body);

      // 带 id：比特兼容 upsert（更新已有环境）
      if (existingId) {
        const existing = db.getProfile(existingId);
        const gate = assertProfileOwner(user, existing, { write: true });
        if (!gate.ok) return res.json(fail(gate.msg));
        const row = db.updateProfileMeta(existingId, {
          name: body.name != null ? body.name : existing.name,
          remark: body.remark != null ? body.remark : existing.remark,
          groupId: body.groupId || body.group_id || existing.group_id,
          platform: body.url || body.platform || existing.platform,
          fingerprint_json: fp,
          timezone: fields.timezone,
          language: fields.language,
          latitude: fields.latitude,
          longitude: fields.longitude,
          country: fields.country,
          last_ip: lastIp,
          ...proxyFields,
        });
        if (manager.getSession(existingId)) {
          await manager.closeProfile(existingId).catch(() => {});
        }
        return res.json(ok(toBitProfile(row)));
      }

      const row = db.createProfile({
        owner_id: user.id,
        group_id: body.groupId || body.group_id || 'default',
        name: body.name || `TK-${Date.now()}`,
        remark: body.remark || '',
        platform: body.url || body.platform || 'https://www.tiktok.com',
        ...proxyFields,
        fingerprint_json: fp,
        timezone: fields.timezone,
        language: fields.language,
        latitude: fields.latitude,
        longitude: fields.longitude,
        country: fields.country,
        last_ip: lastIp,
      });
      res.json(ok(toBitProfile(row)));
    } catch (e) {
      res.json(fail(e.message || '创建失败'));
    }
  });

  /** 更新备注 / 名称 / 分组（对齐比特管理体验） */
  router.post('/browser/update/partial', authMiddleware, (req, res) => {
    try {
      const id = String(req.body?.id || '');
      const row = db.getProfile(id);
      const gate = assertProfileOwner(req.currentUser, row, { write: true });
      if (!gate.ok) return res.json(fail(gate.msg));
      const updated = db.updateProfileMeta(id, {
        name: req.body?.name,
        remark: req.body?.remark,
        groupId: req.body?.groupId,
      });
      res.json(ok(toBitProfile(updated)));
    } catch (e) {
      res.json(fail(e.message || '更新失败'));
    }
  });

  return router;
}

module.exports = { createRouter, ok, fail, assertProfileOwner };
