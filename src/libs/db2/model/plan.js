//
// MyRA
//
// Copyright © 2018 Province of British Columbia
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Created by Jason Leach on 2018-05-10.
//

'use strict';

import { flatten, has } from 'lodash';
import GrazingSchedule from './grazingschedule';
import Model from './model';
import Pasture from './pasture';
import PlanExtension from './planextension';
import PlanStatus from './planstatus';
import MinisterIssue from './ministerissue';
import PlanStatusHistory from './planstatushistory';
import PlanConfirmation from './planconfirmation';
import User from './user';
import InvasivePlantChecklist from './invasiveplantchecklist';
import AdditionalRequirement from './additionalrequirement';
import ManagementConsideration from './managementconsideration';
import PlantCommunity from './plantcommunity';
import IndicatorPlant from './indicatorplant';
import MonitoringArea from './monitoringarea';
import MonitoringAreaPurpose from './monitoringareapurpose';
import PlantCommunityAction from './plantcommunityaction';
import GrazingScheduleEntry from './grazingscheduleentry';
import MinisterIssueAction from './ministerissueaction';
import MinisterIssuePasture from './ministerissuepasture';

const duplicateEach = async (db, model, rows, map, finishedCb) => {
  const promises = rows.map(
    async (row) => {
      if (has(row, 'id')) {
        const { id, ...rowData } = row;

        const newRow = await model.create(db, map(rowData));
        return [newRow, { ...row, id }];
      }

      const newRow = await model.create(db, map(row));
      return [newRow, row];
    },
  );

  const newRows = await Promise.all(promises);

  if (finishedCb) {
    return Promise.all(newRows.map(finishedCb));
  }

  return newRows.map(([newRow]) => newRow);
};

export default class Plan extends Model {
  constructor(data, db = undefined) {
    const obj = {};
    Object.keys(data).forEach((key) => {
      if (Plan.fields.indexOf(`${Plan.table}.${key}`) > -1) {
        obj[key] = data[key];
      }
    });

    super(obj, db);

    this.status = new PlanStatus(PlanStatus.extract(data));
    // The left join will return `null` values when no related record exists
    // so we manually exclude them.
    const extension = new PlanExtension(PlanExtension.extract(data));
    this.extension = extension.id === null ? null : extension;
    this.creator = new User(User.extract(data));
  }

  static get fields() {
    // TODO:(jl) Work with consumers to remove 'agreement_id' from the selected
    // fields.

    // primary key *must* be first!
    return [
      'id', 'range_name', 'plan_start_date', 'plan_end_date',
      'notes', 'alt_business_name', 'agreement_id', 'status_id',
      'uploaded', 'amendment_type_id', 'created_at', 'updated_at',
      'effective_at', 'submitted_at', 'creator_id', 'canonical_id',
    ].map(f => `${Plan.table}.${f}`);
  }

  static get table() {
    return 'plan';
  }

  static async findCurrentVersion(db, canonicalId) {
    try {
      const { rows: [currentVersion] } = await db.raw(`
        SELECT plan.*
        FROM plan_version
        INNER JOIN plan ON plan_version.plan_id = plan.id
        WHERE plan_version.canonical_id = ? AND version = -1;
        `, [canonicalId]);
      return currentVersion;
    } catch (e) {
      return null;
    }
  }

  static async findWithStatusExtension(
    db, where, order,
    page = undefined, limit = undefined, whereNot = undefined,
  ) {
    const myFields = [
      ...Plan.fields,
      ...PlanStatus.fields.map(f => `${f} AS ${f.replace('.', '_')}`),
      ...PlanExtension.fields.map(f => `${f} AS ${f.replace('.', '_')}`),
      ...User.fields.map(f => `${f} AS ${f.replace('.', '_')}`),
    ];

    try {
      let results = [];
      const q = db
        .select(myFields)
        .from(Plan.table)
        .join('ref_plan_status', { 'plan.status_id': 'ref_plan_status.id' })
        // left join otherwise if extension is NULL we don't get any results
        .leftJoin('extension', { 'plan.extension_id': 'extension.id' })
        .join('user_account', { 'plan.creator_id': 'user_account.id' })
        .where({ ...where, uploaded: true })
        .orderBy(...order);

      if (whereNot) {
        results = q.andWhere(...whereNot);
      }

      if (page && limit) {
        const offset = limit * (page - 1);
        results = await q
          .offset(offset)
          .limit(limit);
      } else {
        results = await q;
      }

      return results.map(row => new Plan(row, db));
    } catch (err) {
      throw err;
    }
  }

  // Fetch the Agreement ID associated with a given Plan
  static async agreementForPlanId(db, planId) {
    if (!db || !planId) {
      return [];
    }

    const results = await db
      .select('agreement_id')
      .from(Plan.table)
      .where({ id: planId });

    if (results.length === 0) return null;

    const [result] = results;
    return result.agreement_id;
  }

  static async duplicateAll(db, planId) {
    const planRow = await Plan.findById(db, planId);
    const plan = new Plan(planRow, db);

    await plan.eagerloadAllOneToMany();

    const { id: oldPlanId, ...planData } = planRow;
    const newPlan = await Plan.create(db, {
      ...planData,
    });

    try {
      db.raw('BEGIN');

      // Duplicate pastures
      const newPastures = await duplicateEach(
        db,
        Pasture,
        plan.pastures,
        pasture => ({ ...pasture, plan_id: newPlan.id }),
        async ([newPasture, oldPasture]) => {
          // Duplicate plant communities
          const newPlantCommunities = await duplicateEach(
            db,
            PlantCommunity,
            oldPasture.plantCommunities,
            pc => ({ ...pc, pasture_id: newPasture.id }),
            async ([newCommunity, oldCommunity]) => {
              // Duplicate indicator plants
              const newIndicatorPlants = await duplicateEach(
                db,
                IndicatorPlant,
                oldCommunity.indicatorPlants,
                ip => ({ ...ip, plant_community_id: newCommunity.id }),
              );

              // Duplicate monitoring areas
              const newMonitoringAreas = await duplicateEach(
                db,
                MonitoringArea,
                oldCommunity.monitoringAreas,
                area => ({ ...area, plant_community_id: newCommunity.id }),
                async ([newArea, oldArea]) => {
                  // Duplicate monitoring area purposes
                  const newPurposes = await duplicateEach(
                    db,
                    MonitoringAreaPurpose,
                    oldArea.purposes,
                    purpose => ({ ...purpose, monitoring_area_id: newArea.id }),
                  );

                  return {
                    ...newArea,
                    purposes: newPurposes,
                  };
                },
              );

              // Duplicate plant community actions
              const newActions = await duplicateEach(
                db,
                PlantCommunityAction,
                oldCommunity.plantCommunityActions,
                action => ({ ...action, plant_community_id: newCommunity.id }),
              );

              return {
                ...newCommunity,
                indicatorPlants: newIndicatorPlants,
                monitoringAreas: newMonitoringAreas,
                plantCommunityActions: newActions,
              };
            },
          );

          return {
            ...newPasture,
            plantCommunities: newPlantCommunities,
            original: oldPasture,
          };
        },
      );

      // Duplicate grazing schedules
      const newGrazingSchedules = await duplicateEach(
        db,
        GrazingSchedule,
        plan.grazingSchedules,
        schedule => ({ ...schedule, plan_id: newPlan.id }),
        async ([oldSchedule, newSchedule]) => {
          // Duplicate grazing schedule entries
          const newEntries = await duplicateEach(
            db,
            GrazingScheduleEntry,
            oldSchedule.grazingScheduleEntries,
            (entry) => {
              const pasture = newPastures.find(p => p.original.id === entry.pastureId);
              return {
                ...entry,
                grazing_schedule_id: newSchedule.id,
                pasture_id: pasture.id,
              };
            },
          );

          return {
            ...newSchedule,
            grazingScheduleEntries: newEntries,
          };
        },
      );

      // Duplicate additional requirements
      const newAdditionalRequirements = await duplicateEach(
        db,
        AdditionalRequirement,
        plan.additionalRequirements,
        requirement => ({ ...requirement, plan_id: newPlan.id }),
      );

      // Duplicate minister issues
      const newMinisterIssues = await duplicateEach(
        db,
        MinisterIssue,
        plan.ministerIssues,
        issue => ({ ...issue, plan_id: newPlan.id }),
        async ([newIssue, oldIssue]) => {
          // Duplicate minister issue actions
          const newActions = await duplicateEach(
            db,
            MinisterIssueAction,
            oldIssue.ministerIssueActions,
            action => ({ ...action, minister_issue_id: newIssue.id }),
          );

          // Duplicate minister issue pastures
          const newMinisterPastures = await duplicateEach(
            db,
            MinisterIssuePasture,
            oldIssue.pastures,
            (pastureId) => {
              const newPasture = newPastures.find(p => p.original.id === pastureId);
              return {
                pasture_id: newPasture.id,
                minister_issue_id: newIssue.id,
              };
            },
          );

          return {
            ...newIssue,
            ministerIssueActions: newActions,
            ministerIssuePastures: newMinisterPastures,
          };
        },
      );

      // Duplicate management considerations
      const newConsiderations = await duplicateEach(
        db,
        ManagementConsideration,
        plan.managementConsiderations,
        consideration => ({ ...consideration, plan_id: newPlan.id }),
      );

      db.raw('COMMIT');

      return {
        ...newPlan,
        pastures: newPastures,
        additionalRequirements: newAdditionalRequirements,
        ministerIssues: newMinisterIssues,
        managementConsiderations: newConsiderations,
        grazingSchedules: newGrazingSchedules,
      };
    } catch (e) {
      db.raw('ROLLBACK');
      throw e;
    }
  }

  async eagerloadAllOneToMany() {
    await this.fetchPastures();
    await this.fetchGrazingSchedules();
    await this.fetchMinisterIssues();
    await this.fetchPlanStatusHistory();
    await this.fetchPlanConfirmations();
    await this.fetchInvasivePlantChecklist();
    await this.fetchAdditionalRequirements();
    await this.fetchManagementConsiderations();
  }

  async fetchPlanConfirmations() {
    const confirmations = await PlanConfirmation.find(
      this.db, { plan_id: this.id },
    );
    this.confirmations = confirmations || [];
  }

  async fetchPastures() {
    const where = { plan_id: this.id };
    const pastures = await Pasture.find(this.db, where);

    const promises = pastures.map(p =>
      [
        p.fetchPlantCommunities(this.db, { pasture_id: p.id }),
      ]);

    await Promise.all(flatten(promises));

    this.pastures = pastures || [];
  }

  async fetchGrazingSchedules() {
    const order = ['year', 'asc'];
    const where = { plan_id: this.id };
    const schedules = await GrazingSchedule.find(this.db, where, order);
    // egar load grazing schedule entries.
    const promises = schedules.map(s => s.fetchGrazingSchedulesEntries(
      this.db,
      {
        grazing_schedule_id: s.id,
      },
    ));
    await Promise.all(promises);

    this.grazingSchedules = schedules || [];
  }

  async fetchMinisterIssues() {
    const where = { plan_id: this.id };
    const ministerIssues = await MinisterIssue.findWithType(this.db, where);

    // eagar load pasture ids and minister issue actions.
    const promises = ministerIssues.map(i =>
      [
        i.fetchPastureIds(this.db, { minister_issue_id: i.id }),
        i.fetchMinisterIssueActions(this.db, { issue_id: i.id }),
      ]);

    await Promise.all(flatten(promises));

    this.ministerIssues = ministerIssues || [];
  }

  async fetchPlanStatusHistory() {
    const where = { plan_id: this.id };
    const planStatusHistory = await PlanStatusHistory.findWithUser(this.db, where);

    this.planStatusHistory = planStatusHistory || [];
  }

  async fetchInvasivePlantChecklist() {
    const where = { plan_id: this.id };
    const checklist = await InvasivePlantChecklist.findOne(this.db, where);

    this.invasivePlantChecklist = checklist || {};
  }

  async fetchAdditionalRequirements() {
    const where = { plan_id: this.id };
    const requirements = await AdditionalRequirement.findWithCategory(this.db, where);

    this.additionalRequirements = requirements || [];
  }

  async fetchManagementConsiderations() {
    const where = { plan_id: this.id };
    const considerations = await ManagementConsideration.findWithType(this.db, where);

    this.managementConsiderations = considerations || [];
  }
}
